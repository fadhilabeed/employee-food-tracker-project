const express = require("express");
const pool = require("../db");

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
    const employeeResult = await pool.query(
      `SELECT id, full_name, department
       FROM employees
       WHERE emp_code = $1 AND is_active = TRUE`,
      [empCode]
    );

    if (employeeResult.rowCount === 0) {
      await pool.query(
        `INSERT INTO meal_logs (emp_id, meal_date, status)
         VALUES (NULL, CURRENT_DATE, 'DENIED')`
      );
      return res.status(200).json({ status: "DENIED", reason: "unknown" });
    }

    const employee = employeeResult.rows[0];
    const mealsTodayResult = await pool.query(
      `SELECT COUNT(*)::int AS meals_today
       FROM meal_logs
       WHERE emp_id = $1
         AND meal_date = CURRENT_DATE
         AND status = 'ALLOWED'`,
      [employee.id]
    );

    const mealsToday = mealsTodayResult.rows[0].meals_today;

    if (mealsToday >= 1) {
      await pool.query(
        `INSERT INTO meal_logs (emp_id, meal_date, status)
         VALUES ($1, CURRENT_DATE, 'DENIED')`,
        [employee.id]
      );
      return res.status(200).json({ status: "DENIED", reason: "quota_used" });
    }

    await pool.query(
      `INSERT INTO meal_logs (emp_id, meal_date, status)
       VALUES ($1, CURRENT_DATE, 'ALLOWED')`,
      [employee.id]
    );

    return res.status(200).json({
      status: "ALLOWED",
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
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM meal_logs
       WHERE meal_date = CURRENT_DATE`
    );
    return res.json({ count: result.rows[0]?.count || 0 });
  } catch (error) {
    return res.status(500).json({ error: getErrMsg(error) });
  }
});

module.exports = router;
