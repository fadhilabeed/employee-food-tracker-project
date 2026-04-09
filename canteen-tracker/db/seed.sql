INSERT INTO employees (emp_code, full_name, department, is_active)
VALUES
  ('EMP-001', 'Alice Johnson', 'Finance', TRUE),
  ('EMP-002', 'Brian Smith', 'Operations', TRUE),
  ('EMP-003', 'Carla Gomez', 'Engineering', TRUE),
  ('EMP-004', 'Daniel Lee', 'Human Resources', TRUE),
  ('EMP-005', 'Eva Brown', 'Administration', TRUE)
ON CONFLICT (emp_code) DO NOTHING;
