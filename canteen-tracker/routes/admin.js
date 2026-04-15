const express = require("express");
const archiver = require("archiver");
const multer = require("multer");
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");
const { stringify } = require("csv-stringify/sync");
const pool = require("../db");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});
const getErrMsg = (error) =>
  (error && typeof error.message === "string" && error.message.trim()) ||
  String(error) ||
  "Internal server error";

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseEmployeesCsv(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], error: "empty file" };
  }

  const headerCells = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  let idxCode = headerCells.indexOf("emp_code");
  let idxName = headerCells.indexOf("full_name");
  let idxDept = headerCells.indexOf("department");

  if (idxCode === -1 && headerCells.includes("code")) {
    idxCode = headerCells.indexOf("code");
  }
  if (idxName === -1 && headerCells.includes("name")) {
    idxName = headerCells.indexOf("name");
  }
  if (idxDept === -1 && headerCells.includes("dept")) {
    idxDept = headerCells.indexOf("dept");
  }

  if (idxCode === -1 || idxName === -1) {
    return {
      rows: [],
      error: "CSV must include header row with emp_code (or code) and full_name (or name)"
    };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const empCode = cells[idxCode] ? cells[idxCode].trim() : "";
    const fullName = cells[idxName] ? cells[idxName].trim() : "";
    const department =
      idxDept !== -1 && cells[idxDept] ? cells[idxDept].trim() : "";
    if (!empCode && !fullName) continue;
    rows.push({
      emp_code: empCode,
      full_name: fullName,
      department: department || null
    });
  }

  return { rows };
}

async function bulkInsertEmployees(rows, res) {
  if (!rows.length) {
    return res.status(400).json({ error: "no valid rows to import" });
  }

  const client = await pool.connect();
  const inserted = [];
  const skipped = [];
  const errors = [];

  try {
    await client.query("BEGIN");
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const empCode = typeof row.emp_code === "string" ? row.emp_code.trim() : "";
      const fullName = typeof row.full_name === "string" ? row.full_name.trim() : "";
      const dept =
        row.department === null || row.department === undefined
          ? null
          : String(row.department).trim();

      if (!empCode || !fullName) {
        errors.push({ index: i, emp_code: empCode || null, error: "emp_code and full_name required" });
        continue;
      }

      try {
        const result = await client.query(
          `INSERT INTO employees (emp_code, full_name, department)
           VALUES ($1, $2, $3)
           ON CONFLICT (emp_code) DO NOTHING
           RETURNING id, emp_code, full_name, department, is_active`,
          [empCode, fullName, dept || null]
        );
        if (result.rowCount === 0) {
          skipped.push({ emp_code: empCode, reason: "duplicate" });
        } else {
          inserted.push(result.rows[0]);
        }
      } catch (error) {
        errors.push({ index: i, emp_code: empCode, error: getErrMsg(error) });
      }
    }

    await client.query("COMMIT");
    return res.status(201).json({
      inserted: inserted.length,
      skipped: skipped.length,
      error_count: errors.length,
      skipped_detail: skipped,
      errors,
      employees: inserted
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: getErrMsg(error) });
  } finally {
    client.release();
  }
}

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

router.post("/employees/bulk", async (req, res) => {
  const { employees } = req.body;
  if (!Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: "employees must be a non-empty array" });
  }
  return bulkInsertEmployees(employees, res);
});

router.post("/employees/import/csv", upload.single("file"), async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "CSV file required (form field name: file)" });
  }

  const text = req.file.buffer.toString("utf8");
  const parsed = parseEmployeesCsv(text);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  return bulkInsertEmployees(parsed.rows, res);
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

router.delete("/employees/all", async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM meal_logs");
    const employeeResult = await client.query("DELETE FROM employees");
    await client.query("COMMIT");
    return res.json({ success: true, deleted: employeeResult.rowCount });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: getErrMsg(error) });
  } finally {
    client.release();
  }
});

router.delete("/employees/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid employee id" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM meal_logs WHERE emp_id = $1`, [id]);
    const result = await client.query(
      `DELETE FROM employees WHERE id = $1 RETURNING id, emp_code, full_name`,
      [id]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "employee not found" });
    }

    await client.query("COMMIT");
    return res.json({ ok: true, deleted: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: getErrMsg(error) });
  } finally {
    client.release();
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

router.get("/logs/export", async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const to = typeof req.query.to === "string" ? req.query.to.toString().trim() : "";
  const formatRaw = typeof req.query.format === "string" ? req.query.format.trim() : "csv";
  const format = formatRaw.toLowerCase();

  if (!from || !to) {
    return res.status(400).json({ error: "from and to query params are required (YYYY-MM-DD)" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  }
  if (!["csv", "excel"].includes(format)) {
    return res.status(400).json({ error: "format must be csv or excel" });
  }

  try {
    const result = await pool.query(
      `SELECT
         m.scanned_at,
         m.meal_date,
         e.emp_code,
         e.full_name,
         e.department,
         m.status
       FROM meal_logs m
       LEFT JOIN employees e ON e.id = m.emp_id
       WHERE m.meal_date >= $1 AND m.meal_date <= $2
       ORDER BY m.meal_date DESC, m.scanned_at DESC`,
      [from, to]
    );

    const rows = result.rows.map((row) => {
      const scannedAt = row.scanned_at ? new Date(row.scanned_at) : null;
      const time = scannedAt
        ? scannedAt.toLocaleTimeString("en-GB", { hour12: false })
        : "";
      const date = row.meal_date ? String(row.meal_date) : "";
      return {
        Time: time,
        Date: date,
        "Emp Code": row.emp_code || "",
        "Full Name": row.full_name || "",
        Department: row.department || "",
        Status: row.status || ""
      };
    });

    const safeFrom = from.replaceAll(/[^0-9-]/g, "");
    const safeTo = to.replaceAll(/[^0-9-]/g, "");
    const fileBase =
      safeFrom === safeTo ? `meal-logs-${safeFrom}` : `meal-logs-${safeFrom}-to-${safeTo}`;

    if (format === "csv") {
      const csv = stringify(rows, {
        header: true,
        columns: ["Time", "Date", "Emp Code", "Full Name", "Department", "Status"]
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.csv"`);
      return res.send(csv);
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Meal Logs");
    sheet.columns = [
      { header: "Time", key: "Time", width: 12 },
      { header: "Date", key: "Date", width: 12 },
      { header: "Emp Code", key: "Emp Code", width: 14 },
      { header: "Full Name", key: "Full Name", width: 24 },
      { header: "Department", key: "Department", width: 18 },
      { header: "Status", key: "Status", width: 12 }
    ];
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.xlsx"`);
    return res.send(Buffer.from(buffer));
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
