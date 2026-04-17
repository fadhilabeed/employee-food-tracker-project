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
    function getMealCategory(hour) {
      // 11pm - 7am => breakfast, 11am - 2pm => lunch, 5pm - 7pm => dinner
      // outside => outside defined windows
      if (hour >= 23 || hour < 7) return "breakfast";
      if (hour >= 11 && hour < 14) return "lunch";
      if (hour >= 17 && hour < 19) return "dinner";
      return "outside";
    }

    const hour = new Date().getHours();
    const meal_category = getMealCategory(hour);

    const employeeResult = await pool.query(
      `SELECT
        e.*,
        COUNT(m.id) as meals_today
       FROM employees e
       LEFT JOIN meal_logs m
         ON m.emp_id = e.id
        AND m.meal_date = CURRENT_DATE
        AND m.status = 'ALLOWED'
       WHERE e.emp_code = $1 AND e.is_active = true
       GROUP BY e.id`,
      [empCode]
    );

    if (employeeResult.rowCount === 0) {
      await pool.query(
        `INSERT INTO meal_logs (emp_id, meal_date, status, meal_category)
         VALUES (NULL, CURRENT_DATE, 'DENIED', $1)`,
        [meal_category]
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
        `INSERT INTO meal_logs (emp_id, meal_date, status, meal_category)
         VALUES ($1, CURRENT_DATE, 'DENIED', $2)`,
        [employee.id, meal_category]
      );
      return res.status(200).json({
        status: "DENIED",
        reason: "quota_used",
        meal_category
      });
    }

    await pool.query(
      `INSERT INTO meal_logs (emp_id, meal_date, status, meal_category)
       VALUES ($1, CURRENT_DATE, 'ALLOWED', $2)`,
      [employee.id, meal_category]
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
