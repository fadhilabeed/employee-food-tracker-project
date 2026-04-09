CREATE TABLE employees (
  id          SERIAL PRIMARY KEY,
  emp_code    VARCHAR(20) UNIQUE NOT NULL,
  full_name   VARCHAR(100) NOT NULL,
  department  VARCHAR(60),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE meal_logs (
  id          SERIAL PRIMARY KEY,
  emp_id      INT REFERENCES employees(id),
  meal_date   DATE NOT NULL,
  scanned_at  TIMESTAMP DEFAULT NOW(),
  status      VARCHAR(10) NOT NULL CHECK (status IN ('ALLOWED', 'DENIED'))
);

CREATE VIEW today_eligibility AS
SELECT
  e.id,
  e.emp_code,
  e.full_name,
  e.department,
  COUNT(m.id) AS meals_today,
  CASE WHEN COUNT(m.id) = 0 THEN 'ELIGIBLE' ELSE 'USED' END AS status
FROM employees e
LEFT JOIN meal_logs m
  ON m.emp_id = e.id AND m.meal_date = CURRENT_DATE AND m.status = 'ALLOWED'
WHERE e.is_active = TRUE
GROUP BY e.id, e.emp_code, e.full_name, e.department;
