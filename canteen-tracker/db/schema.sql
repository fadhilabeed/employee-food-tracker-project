CREATE TABLE IF NOT EXISTS employees (
  id          SERIAL PRIMARY KEY,
  emp_code    VARCHAR(20) UNIQUE NOT NULL,
  full_name   VARCHAR(100) NOT NULL,
  department  VARCHAR(60),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')
);

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employment_status VARCHAR(20) DEFAULT 'permanent',
  ADD COLUMN IF NOT EXISTS schedule_type VARCHAR(10) DEFAULT 'regular';

ALTER TABLE employees
  ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta');

CREATE TABLE IF NOT EXISTS meal_logs (
  id          SERIAL PRIMARY KEY,
  emp_id      INT REFERENCES employees(id),
  meal_date   DATE NOT NULL,
  scanned_at  TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta'),
  meal_category VARCHAR(10) DEFAULT 'outside',
  status      VARCHAR(10) NOT NULL CHECK (status IN ('ALLOWED', 'DENIED'))
);

ALTER TABLE meal_logs
  ADD COLUMN IF NOT EXISTS meal_category VARCHAR(10) DEFAULT 'outside';

ALTER TABLE meal_logs
  ALTER COLUMN scanned_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta');

ALTER TABLE meal_logs
  DROP CONSTRAINT IF EXISTS meal_logs_meal_category_check;

ALTER TABLE meal_logs
  ADD CONSTRAINT meal_logs_meal_category_check
  CHECK (meal_category IN ('breakfast', 'lunch', 'dinner', 'supper', 'outside'));

CREATE TABLE IF NOT EXISTS "session" (
  sid VARCHAR PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON "session" (expire);

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta'),
  updated_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')
);

ALTER TABLE admin_users
  ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta'),
  ALTER COLUMN updated_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta');

DROP VIEW IF EXISTS today_eligibility;

CREATE VIEW today_eligibility AS
SELECT
  e.id,
  e.emp_code,
  e.full_name,
  e.department,
  e.employment_status,
  e.schedule_type,
  COUNT(m.id) AS meals_today,
  CASE
    WHEN e.schedule_type = 'split' AND COUNT(m.id) < 2 THEN 'ELIGIBLE'
    WHEN e.schedule_type = 'regular' AND COUNT(m.id) < 1 THEN 'ELIGIBLE'
    ELSE 'USED'
  END AS status
FROM employees e
LEFT JOIN meal_logs m
  ON m.emp_id = e.id
 AND m.meal_date = ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date)
 AND m.status = 'ALLOWED'
WHERE e.is_active = TRUE
GROUP BY
  e.id,
  e.emp_code,
  e.full_name,
  e.department,
  e.employment_status,
  e.schedule_type;
