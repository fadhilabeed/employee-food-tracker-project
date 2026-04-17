# Canteen Tracker

Web-based employee canteen food tracker where employees scan QR badges to claim one meal per day.

## Tech Stack

- Node.js + Express
- PostgreSQL (`pg`)
- Vanilla HTML/CSS/JS
- QR scanning via `html5-qrcode` CDN
- QR generation via `qrcode` npm package

## Project Structure

```
canteen-tracker/
├── db/
│   ├── schema.sql
│   └── seed.sql
├── public/
│   ├── scanner.html
│   ├── admin.html
│   └── style.css
├── routes/
│   ├── scan.js
│   └── admin.js
├── db.js
├── server.js
├── .env.example
└── package.json
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

3. Update `.env` values:
   - `DB_HOST`
   - `DB_PORT`
   - `DB_NAME`
   - `DB_USER`
   - `DB_PASSWORD`
   - `PORT`

4. Start dummy PostgreSQL database (Docker):

   ```bash
   npm run db:up
   ```

   This creates a local Postgres DB at `localhost:5433` and auto-runs:
   - `db/schema.sql`
   - `db/seed.sql`

5. Start server:

   ```bash
   npm start
   ```

6. Open app:

- Scanner page: [http://localhost:3000/scanner.html](http://localhost:3000/scanner.html) — requires admin login
- Admin dashboard: [http://localhost:3000/admin.html](http://localhost:3000/admin.html)

## Manual DB setup (optional, non-Docker)

If you already have PostgreSQL installed locally, you can run:

1. Create schema:

   ```bash
   psql -U <user> -d <database> -f db/schema.sql
   ```

2. Seed sample data:

   ```bash
   psql -U <user> -d <database> -f db/seed.sql
   ```

3. Start server:

   ```bash
   npm start
   ```

4. Open app:

- Scanner page: [http://localhost:3000/scanner.html](http://localhost:3000/scanner.html) — requires admin login
- Admin dashboard: [http://localhost:3000/admin.html](http://localhost:3000/admin.html)

## API Endpoints

- `POST /api/scan` with `{ emp_code }` — requires admin session
- `GET /api/employees`
- `GET /api/departments`
- `POST /api/employees`
- `POST /api/employees/bulk` — body `{ "employees": [{ "emp_code", "full_name", "department?" }] }` (duplicates skipped)
- `POST /api/employees/import/csv` — multipart form field `file` (CSV from Excel: save as CSV UTF-8; headers `emp_code`, `full_name`, optional `department`)
- `DELETE /api/employees/:id` — removes employee and their `meal_logs` rows
- `PATCH /api/employees/:id`
- `GET /api/logs?date=YYYY-MM-DD`
- `GET /api/employees/:id/qr`
- `GET /api/employees/qr/bulk`
- `GET /api/employees/qr/bulk?department=<department-name>` — optional department filter
- `GET /api/employees/qr/bulk?employment_status=<status>` — optional employment status filter
- `GET /api/employees/qr/bulk?department=<department-name>&employment_status=<status>` — combine both filters

### Bulk import files

- `public/employees_import_template.csv` — downloadable CSV template (also under `db/employees_import_template.csv`)
