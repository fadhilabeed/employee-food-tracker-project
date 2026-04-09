const express = require("express");
const archiver = require("archiver");
const QRCode = require("qrcode");
const pool = require("../db");

const router = express.Router();
const getErrMsg = (error) =>
  (error && typeof error.message === "string" && error.message.trim()) ||
  String(error) ||
  "Internal server error";

router.get("/employees", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         e.id,
         e.emp_code,
         e.full_name,
         e.department,
         e.is_active,
         COALESCE(t.status, 'INACTIVE') AS status
       FROM employees e
       LEFT JOIN today_eligibility t ON t.id = e.id
       ORDER BY e.id ASC`
    );
    return res.json(result.rows);
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

router.get("/departments", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT department
       FROM employees
       WHERE department IS NOT NULL
         AND BTRIM(department) <> ''
       ORDER BY department ASC`
    );
    return res.json(result.rows.map((row) => row.department));
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

router.post("/employees", async (req, res) => {
  const { emp_code: rawEmpCode, full_name: rawFullName, department } = req.body;
  const empCode = typeof rawEmpCode === "string" ? rawEmpCode.trim() : "";
  const fullName = typeof rawFullName === "string" ? rawFullName.trim() : "";
  const dept = typeof department === "string" ? department.trim() : null;

  if (!empCode || !fullName) {
    return res.status(400).json({ error: "emp_code and full_name are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO employees (emp_code, full_name, department)
       VALUES ($1, $2, $3)
       RETURNING id, emp_code, full_name, department, is_active, created_at`,
      [empCode, fullName, dept || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "emp_code already exists" });
    }
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

router.patch("/employees/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { is_active: isActive } = req.body;

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid employee id" });
  }

  if (typeof isActive !== "boolean") {
    return res.status(400).json({ error: "is_active must be boolean" });
  }

  try {
    const result = await pool.query(
      `UPDATE employees
       SET is_active = $1
       WHERE id = $2
       RETURNING id, emp_code, full_name, department, is_active`,
      [isActive, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "employee not found" });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

router.patch("/employees/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const rawStatus = typeof req.body.status === "string" ? req.body.status.trim() : "";
  const status = rawStatus.toUpperCase();

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid employee id" });
  }

  if (!["ELIGIBLE", "USED"].includes(status)) {
    return res.status(400).json({ error: "status must be ELIGIBLE or USED" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const employeeResult = await client.query(
      `SELECT id, is_active FROM employees WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (employeeResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "employee not found" });
    }

    const employee = employeeResult.rows[0];
    if (!employee.is_active) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "cannot set status for inactive employee" });
    }

    if (status === "ELIGIBLE") {
      await client.query(
        `DELETE FROM meal_logs
         WHERE emp_id = $1
           AND meal_date = CURRENT_DATE
           AND status = 'ALLOWED'`,
        [id]
      );
    } else {
      const existingAllowed = await client.query(
        `SELECT id
         FROM meal_logs
         WHERE emp_id = $1
           AND meal_date = CURRENT_DATE
           AND status = 'ALLOWED'
         LIMIT 1`,
        [id]
      );

      if (existingAllowed.rowCount === 0) {
        await client.query(
          `INSERT INTO meal_logs (emp_id, meal_date, status)
           VALUES ($1, CURRENT_DATE, 'ALLOWED')`,
          [id]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ ok: true, id, status });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: getErrMsg(error) });
  } finally {
    client.release();
  }
});

router.get("/logs", async (req, res) => {
  const date = req.query.date;
  const targetDate = typeof date === "string" && date.trim() ? date.trim() : null;
  const sql = targetDate
    ? `SELECT
         m.id,
         m.emp_id,
         e.emp_code,
         e.full_name,
         e.department,
         m.meal_date,
         m.scanned_at,
         m.status
       FROM meal_logs m
       LEFT JOIN employees e ON e.id = m.emp_id
       WHERE m.meal_date = $1
       ORDER BY m.scanned_at DESC`
    : `SELECT
         m.id,
         m.emp_id,
         e.emp_code,
         e.full_name,
         e.department,
         m.meal_date,
         m.scanned_at,
         m.status
       FROM meal_logs m
       LEFT JOIN employees e ON e.id = m.emp_id
       WHERE m.meal_date = CURRENT_DATE
       ORDER BY m.scanned_at DESC`;

  try {
    const result = targetDate
      ? await pool.query(sql, [targetDate])
      : await pool.query(sql);
    return res.json(result.rows);
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

router.get("/employees/qr/bulk", async (req, res) => {
  const rawDepartment =
    typeof req.query.department === "string" ? req.query.department.trim() : "";

  if (!rawDepartment) {
    return res.status(400).json({ error: "department query is required" });
  }

  try {
    const result = await pool.query(
      `SELECT id, emp_code
       FROM employees
       WHERE department = $1
       ORDER BY id ASC`
      ,
      [rawDepartment]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "no employees found for department" });
    }

    const safeDepartment = rawDepartment.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `employee-qrs-${safeDepartment}-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    const zip = archiver("zip", { zlib: { level: 9 } });
    zip.on("error", (error) => {
      throw error;
    });
    zip.pipe(res);

    for (const employee of result.rows) {
      const pngBuffer = await QRCode.toBuffer(employee.emp_code, {
        type: "png",
        width: 360,
        margin: 2
      });
      zip.append(pngBuffer, { name: `${employee.emp_code}.png` });
    }

    await zip.finalize();
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

router.get("/employees/:id/qr", async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid employee id" });
  }

  try {
    const employeeResult = await pool.query(
      `SELECT emp_code, full_name FROM employees WHERE id = $1`,
      [id]
    );

    if (employeeResult.rowCount === 0) {
      return res.status(404).json({ error: "employee not found" });
    }

    const employee = employeeResult.rows[0];
    const pngBuffer = await QRCode.toBuffer(employee.emp_code, {
      type: "png",
      width: 360,
      margin: 2
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${employee.emp_code}.png"`
    );
    return res.send(pngBuffer);
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

module.exports = router;
