const express = require("express");
const archiver = require("archiver");
const multer = require("multer");
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");
const { stringify } = require("csv-stringify/sync");
const pool = require("../db");
const path = require("path");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});
const getErrMsg = (error) =>
  (error && typeof error.message === "string" && error.message.trim()) ||
  String(error) ||
  "Internal server error";

const EMPLOYMENT_STATUS_VALUES = new Set([
  "permanent",
  "contract",
  "casual",
  "on_call",
  "trainee"
]);

const SCHEDULE_TYPE_VALUES = new Set(["regular", "split"]);

function normalizeCsvValue(value) {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  return s;
}

function normalizeEmploymentStatus(value) {
  const raw = normalizeCsvValue(value).toLowerCase();
  if (!raw) return null;
  return EMPLOYMENT_STATUS_VALUES.has(raw) ? raw : null;
}

function normalizeScheduleType(value) {
  const raw = normalizeCsvValue(value).toLowerCase();
  if (!raw) return null;
  return SCHEDULE_TYPE_VALUES.has(raw) ? raw : null;
}

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
  const lines = normalized.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
  if (lines.length === 0) {
    return { rows: [], error: "empty file" };
  }

  const headerCells = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  let idxCode = headerCells.indexOf("emp_code");
  let idxName = headerCells.indexOf("full_name");
  let idxDept = headerCells.indexOf("department");
  let idxEmploymentStatus = headerCells.indexOf("employment_status");
  let idxScheduleType = headerCells.indexOf("schedule_type");

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
    const employment_status =
      idxEmploymentStatus !== -1 && cells[idxEmploymentStatus]
        ? cells[idxEmploymentStatus].trim()
        : null;
    const schedule_type =
      idxScheduleType !== -1 && cells[idxScheduleType]
        ? cells[idxScheduleType].trim()
        : null;
    if (!empCode && !fullName) continue;
    rows.push({
      emp_code: empCode,
      full_name: fullName,
      department: department || null,
      employment_status,
      schedule_type
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
      const rawEmploymentStatus =
        row.employment_status === null || row.employment_status === undefined
          ? ""
          : String(row.employment_status).trim();
      const rawScheduleType =
        row.schedule_type === null || row.schedule_type === undefined
          ? ""
          : String(row.schedule_type).trim();

      if (!empCode || !fullName) {
        errors.push({ index: i, emp_code: empCode || null, error: "emp_code and full_name required" });
        continue;
      }

      try {
        const employmentStatus = rawEmploymentStatus
          ? normalizeEmploymentStatus(rawEmploymentStatus)
          : null;
        if (rawEmploymentStatus && !employmentStatus) {
          errors.push({
            index: i,
            emp_code: empCode || null,
            error: `invalid employment_status: ${rawEmploymentStatus}`
          });
          continue;
        }

        const scheduleType = rawScheduleType
          ? normalizeScheduleType(rawScheduleType)
          : null;
        if (rawScheduleType && !scheduleType) {
          errors.push({
            index: i,
            emp_code: empCode || null,
            error: `invalid schedule_type: ${rawScheduleType}`
          });
          continue;
        }

        const finalEmploymentStatus = employmentStatus || "permanent";
        const finalScheduleType = scheduleType || "regular";

        const result = await client.query(
          `INSERT INTO employees (emp_code, full_name, department, employment_status, schedule_type)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (emp_code) DO NOTHING
           RETURNING id, emp_code, full_name, department, employment_status, schedule_type, is_active`,
          [empCode, fullName, dept || null, finalEmploymentStatus, finalScheduleType]
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
         e.employment_status,
         e.schedule_type,
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
  const {
    emp_code: rawEmpCode,
    full_name: rawFullName,
    department,
    employment_status: rawEmploymentStatus,
    schedule_type: rawScheduleType
  } = req.body;
  const empCode = typeof rawEmpCode === "string" ? rawEmpCode.trim() : "";
  const fullName = typeof rawFullName === "string" ? rawFullName.trim() : "";
  const dept = typeof department === "string" ? department.trim() : null;

  const employmentStatus = typeof rawEmploymentStatus === "string" ? rawEmploymentStatus.trim() : "";
  const scheduleType = typeof rawScheduleType === "string" ? rawScheduleType.trim() : "";

  const normalizedEmploymentStatus = employmentStatus
    ? normalizeEmploymentStatus(employmentStatus)
    : null;
  if (employmentStatus && !normalizedEmploymentStatus) {
    return res.status(400).json({ error: "invalid employment_status" });
  }

  const normalizedScheduleType = scheduleType
    ? normalizeScheduleType(scheduleType)
    : null;
  if (scheduleType && !normalizedScheduleType) {
    return res.status(400).json({ error: "invalid schedule_type" });
  }

  const finalEmploymentStatus = normalizedEmploymentStatus || "permanent";
  const finalScheduleType = normalizedScheduleType || "regular";

  if (!empCode || !fullName) {
    return res.status(400).json({ error: "emp_code and full_name are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO employees (emp_code, full_name, department, employment_status, schedule_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, emp_code, full_name, department, employment_status, schedule_type, is_active, created_at`,
      [empCode, fullName, dept || null, finalEmploymentStatus, finalScheduleType]
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
  const { is_active: isActive, schedule_type: rawScheduleType } = req.body;

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "invalid employee id" });
  }

  const setClauses = [];
  const params = [];

  if (typeof isActive === "boolean") {
    setClauses.push(`is_active = $${params.length + 1}`);
    params.push(isActive);
  }

  if (typeof rawScheduleType === "string") {
    const normalizedScheduleType = normalizeScheduleType(rawScheduleType);
    if (!normalizedScheduleType) {
      return res.status(400).json({ error: "invalid schedule_type" });
    }

    setClauses.push(`schedule_type = $${params.length + 1}`);
    params.push(normalizedScheduleType);
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: "no update fields provided" });
  }

  try {
    const result = await pool.query(
      `UPDATE employees
       SET ${setClauses.join(", ")}
       WHERE id = $${params.length + 1}
       RETURNING id, emp_code, full_name, department, employment_status, schedule_type, is_active`,
      [...params, id]
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

    function getMealCategory(hour) {
      if (hour >= 23 || hour < 7) return "breakfast";
      if (hour >= 11 && hour < 14) return "lunch";
      if (hour >= 17 && hour < 19) return "dinner";
      return "outside";
    }

    const hour = new Date().getHours();
    const meal_category = getMealCategory(hour);

    const employeeResult = await client.query(
      `SELECT id, is_active, schedule_type FROM employees WHERE id = $1 FOR UPDATE`,
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

    const maxQuota = employee.schedule_type === "split" ? 2 : 1;

    if (status === "ELIGIBLE") {
      await client.query(
        `DELETE FROM meal_logs
         WHERE emp_id = $1
           AND meal_date = CURRENT_DATE
           AND status = 'ALLOWED'`,
        [id]
      );
    } else {
      const allowedCountResult = await client.query(
        `SELECT COUNT(*)::int AS allowed_count
         FROM meal_logs
         WHERE emp_id = $1
           AND meal_date = CURRENT_DATE
           AND status = 'ALLOWED'`,
        [id]
      );

      const allowedCount = allowedCountResult.rows[0]?.allowed_count || 0;
      const toInsert = Math.max(0, maxQuota - allowedCount);

      for (let i = 0; i < toInsert; i += 1) {
        await client.query(
          `INSERT INTO meal_logs (emp_id, meal_date, status, meal_category)
           VALUES ($1, CURRENT_DATE, 'ALLOWED', $2)`,
          [id, meal_category]
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

  const rawDepartment = typeof req.query.department === "string" ? req.query.department.trim() : "";
  const rawEmploymentStatus =
    typeof req.query.employment_status === "string" ? req.query.employment_status.trim() : "";
  const rawMealCategory =
    typeof req.query.meal_category === "string" ? req.query.meal_category.trim() : "";
  const rawStatus = typeof req.query.status === "string" ? req.query.status.trim() : "";

  const mealCategories = new Set(["breakfast", "lunch", "dinner", "outside"]);
  const mealCategory = rawMealCategory ? rawMealCategory.toLowerCase() : "";
  if (mealCategory && !mealCategories.has(mealCategory)) {
    return res.status(400).json({ error: "invalid meal_category" });
  }

  const status = rawStatus ? rawStatus.toUpperCase() : "";
  if (status && !["ALLOWED", "DENIED"].includes(status)) {
    return res.status(400).json({ error: "invalid status" });
  }

  const employmentStatus = rawEmploymentStatus ? normalizeEmploymentStatus(rawEmploymentStatus) : null;
  if (rawEmploymentStatus && !employmentStatus) {
    return res.status(400).json({ error: "invalid employment_status" });
  }

  try {
    const params = [];
    const whereClauses = [];

    if (targetDate) {
      whereClauses.push(`m.meal_date = $${params.length + 1}`);
      params.push(targetDate);
    } else {
      whereClauses.push(`m.meal_date = CURRENT_DATE`);
    }

    if (rawDepartment) {
      whereClauses.push(`e.department = $${params.length + 1}`);
      params.push(rawDepartment);
    }

    if (employmentStatus) {
      whereClauses.push(`e.employment_status = $${params.length + 1}`);
      params.push(employmentStatus);
    }

    if (mealCategory) {
      whereClauses.push(`COALESCE(m.meal_category, 'outside') = $${params.length + 1}`);
      params.push(mealCategory);
    }

    if (status) {
      whereClauses.push(`m.status = $${params.length + 1}`);
      params.push(status);
    }

    const sql = `
      SELECT
        m.id,
        m.emp_id,
        e.emp_code,
        e.full_name,
        e.department,
        e.employment_status,
        e.schedule_type,
        m.meal_date,
        COALESCE(m.meal_category, 'outside') as meal_category,
        m.scanned_at,
        m.status
      FROM meal_logs m
      LEFT JOIN employees e ON e.id = m.emp_id
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY m.scanned_at DESC
    `;

    const result = await pool.query(sql, params);
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
    const rawDepartment =
      typeof req.query.department === "string" ? req.query.department.trim() : "";
    const rawEmploymentStatus =
      typeof req.query.employment_status === "string" ? req.query.employment_status.trim() : "";
    const rawMealCategory =
      typeof req.query.meal_category === "string" ? req.query.meal_category.trim() : "";
    const rawStatus = typeof req.query.status === "string" ? req.query.status.trim() : "";

    const mealCategories = new Set(["breakfast", "lunch", "dinner", "outside"]);
    const mealCategory = rawMealCategory ? rawMealCategory.toLowerCase() : "";
    if (mealCategory && !mealCategories.has(mealCategory)) {
      return res.status(400).json({ error: "invalid meal_category" });
    }

    const status = rawStatus ? rawStatus.toUpperCase() : "";
    if (status && !["ALLOWED", "DENIED"].includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }

    const employmentStatus = rawEmploymentStatus
      ? normalizeEmploymentStatus(rawEmploymentStatus)
      : null;
    if (rawEmploymentStatus && !employmentStatus) {
      return res.status(400).json({ error: "invalid employment_status" });
    }

    const params = [from, to];
    const whereClauses = ["m.meal_date >= $1", "m.meal_date <= $2"];

    let paramIdx = 3;
    if (rawDepartment) {
      whereClauses.push(`e.department = $${paramIdx}`);
      params.push(rawDepartment);
      paramIdx += 1;
    }

    if (employmentStatus) {
      whereClauses.push(`e.employment_status = $${paramIdx}`);
      params.push(employmentStatus);
      paramIdx += 1;
    }

    if (mealCategory) {
      whereClauses.push(`COALESCE(m.meal_category, 'outside') = $${paramIdx}`);
      params.push(mealCategory);
      paramIdx += 1;
    }

    if (status) {
      whereClauses.push(`m.status = $${paramIdx}`);
      params.push(status);
      paramIdx += 1;
    }

    const result = await pool.query(
      `SELECT
         m.scanned_at,
         m.meal_date,
         COALESCE(m.meal_category, 'outside') as meal_category,
         e.emp_code,
         e.full_name,
         e.department,
         e.employment_status,
         e.schedule_type,
         m.status
       FROM meal_logs m
       LEFT JOIN employees e ON e.id = m.emp_id
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY m.meal_date DESC, m.scanned_at DESC`,
      params
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
        "Employment Status": row.employment_status || "",
        "Schedule Type": row.schedule_type || "",
        Meal: row.meal_category || "",
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
        columns: [
          "Time",
          "Date",
          "Emp Code",
          "Full Name",
          "Department",
          "Employment Status",
          "Schedule Type",
          "Meal",
          "Status"
        ]
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
      { header: "Employment Status", key: "Employment Status", width: 20 },
      { header: "Schedule Type", key: "Schedule Type", width: 16 },
      { header: "Meal", key: "Meal", width: 12 },
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
  const rawEmploymentStatus =
    typeof req.query.employment_status === "string" ? req.query.employment_status.trim() : "";

  try {
    const queryParams = [];
    let whereClause = "";
    const conditions = [];

    if (rawDepartment) {
      queryParams.push(rawDepartment);
      conditions.push(`department = $${queryParams.length}`);
    }

    if (rawEmploymentStatus) {
      queryParams.push(rawEmploymentStatus);
      conditions.push(`employment_status = $${queryParams.length}`);
    }

    if (conditions.length > 0) {
      whereClause = "WHERE " + conditions.join(" AND ");
    }

    const result = await pool.query(
      `SELECT id, emp_code, full_name
       FROM employees
       ${whereClause}
       ORDER BY id ASC`,
      queryParams
    );

    if (result.rowCount === 0) {
      const filterDesc = [];
      if (rawDepartment) filterDesc.push(`department "${rawDepartment}"`);
      if (rawEmploymentStatus) filterDesc.push(`employment status "${rawEmploymentStatus}"`);
      const errorMsg = filterDesc.length > 0
        ? `no employees found for ${filterDesc.join(" and ")}`
        : "no employees found";
      return res.status(404).json({ error: errorMsg });
    }

    const fileLabelParts = [];
    if (rawDepartment) fileLabelParts.push(rawDepartment.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));
    if (rawEmploymentStatus) fileLabelParts.push(rawEmploymentStatus.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));
    const fileLabel = fileLabelParts.length > 0 ? fileLabelParts.join("-") : "all-employees";
    const fileName = `employee-qrs-${fileLabel}-${new Date().toISOString().slice(0, 10)}.zip`;
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
      const sanitizedFullName = (employee.full_name || "employee").replace(/[^a-zA-Z0-9_-]/g, "_");
      const fileName = `${employee.emp_code}_${sanitizedFullName}.png`;
      zip.append(pngBuffer, { name: fileName });
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

router.get("/employees/template", async (_req, res) => {
  const templatePath = path.join(
    __dirname,
    "..",
    "public",
    "employees_import_template.csv"
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  return res.sendFile(templatePath);
});

module.exports = router;
