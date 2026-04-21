const express = require("express");
const pool = require("../db");
const { getJakartaCurrentDate, getJakartaNow, getMealCategory } = require("../utils/jakartaTime");

const router = express.Router();
const getErrMsg = (error) =>
  (error && typeof error.message === "string" && error.message.trim()) ||
  String(error) ||
  "Internal server error";

router.post("/", async (req, res) => {
  const { emp_code: rawEmpCode } = req.body;
  const empCode = typeof rawEmpCode === "string" ? rawEmpCode.trim() : "";

  if (!empCode) {
    return res.status(400).json({ error: "emp_code is required" });
  }

  try {
    const { hour, mealDate, scannedAt } = getJakartaNow();
    const meal_category = getMealCategory(hour);

    const employeeResult = await pool.query(
      `SELECT
        e.*,
        COUNT(m.id) as meals_today
       FROM employees e
       LEFT JOIN meal_logs m
         ON m.emp_id = e.id
        AND m.meal_date = $2
        AND m.status = 'ALLOWED'
       WHERE e.emp_code = $1 AND e.is_active = true
       GROUP BY e.id`,
      [empCode, mealDate]
    );

    if (employeeResult.rowCount === 0) {
      await pool.query(
        `INSERT INTO meal_logs (emp_id, meal_date, scanned_at, status, meal_category)
         VALUES (NULL, $1, $2, 'DENIED', $3)`,
        [mealDate, scannedAt, meal_category]
      );
      return res.status(200).json({
        status: "DENIED",
        reason: "unknown",
        meal_category
      });
    }

    const employee = employeeResult.rows[0];
    const mealsToday = Number(employee.meals_today ?? 0);
    const maxQuota = employee.schedule_type === "split" ? 2 : 1;

    if (mealsToday >= maxQuota) {
      await pool.query(
        `INSERT INTO meal_logs (emp_id, meal_date, scanned_at, status, meal_category)
         VALUES ($1, $2, $3, 'DENIED', $4)`,
        [employee.id, mealDate, scannedAt, meal_category]
      );
      return res.status(200).json({
        status: "DENIED",
        reason: "quota_used",
        meal_category
      });
    }

    await pool.query(
      `INSERT INTO meal_logs (emp_id, meal_date, scanned_at, status, meal_category)
       VALUES ($1, $2, $3, 'ALLOWED', $4)`,
      [employee.id, mealDate, scannedAt, meal_category]
    );

    return res.status(200).json({
      status: "ALLOWED",
      meal_category,
      employee: {
        full_name: employee.full_name,
        department: employee.department
      }
    });
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

router.get("/stats/today", async (_req, res) => {
  try {
    const mealDate = getJakartaCurrentDate();
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM meal_logs
       WHERE meal_date = $1`,
      [mealDate]
    );
    return res.json({ count: result.rows[0]?.count || 0 });
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

module.exports = router;
