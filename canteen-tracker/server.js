const express = require("express");
const path = require("path");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
require("dotenv").config();

const pool = require("./db");
const scanRoutes = require("./routes/scan");
const adminRoutes = require("./routes/admin");
const initSchema = require("./db/init");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE_NAME = "connect.sid";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

app.use(express.json());

const ADMIN_USERNAME = typeof process.env.ADMIN_USERNAME === "string"
  ? process.env.ADMIN_USERNAME.trim()
  : "admin";
const ADMIN_PASSWORD = typeof process.env.ADMIN_PASSWORD === "string"
  ? process.env.ADMIN_PASSWORD
  : "canteen123";
const SESSION_SECRET = typeof process.env.SESSION_SECRET === "string"
  ? process.env.SESSION_SECRET.trim()
  : "dev_session_secret_change_me";

const sessionStore = new (connectPgSimple(session))({
  pool,
  createTableIfMissing: true
});

app.use(
  session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      maxAge: SESSION_MAX_AGE_MS,
      secure: "auto"
    },
    rolling: true
  })
);

app.get("/", (_req, res) => {
  return res.redirect("/scanner.html");
});

function requireAdminSession(req, res, next) {
  if (req.session && req.session.is_admin === true) {
    return next();
  }

  const acceptsHtml =
    typeof req.headers.accept === "string" && req.headers.accept.includes("text/html");
  if (acceptsHtml) {
    return res.redirect("/login");
  }
  return res.status(401).json({ error: "unauthorized" });
}

app.get("/login", (_req, res) => {
  const forceReauth =
    typeof _req.query.reauth === "string" && _req.query.reauth.trim() === "1";
  if (!forceReauth && _req.session && _req.session.is_admin === true) {
    return res.redirect("/admin");
  }
  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/scanner", requireAdminSession, (_req, res) => {
  return res.sendFile(path.join(__dirname, "public", "scanner.html"));
});

app.get("/scanner.html", requireAdminSession, (_req, res) => {
  return res.redirect("/scanner");
});

app.get("/admin", requireAdminSession, (_req, res) => {
  return res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/admin.html", requireAdminSession, (_req, res) => {
  return res.redirect("/admin");
});

app.post("/api/auth/login", async (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  try {
    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });
    req.session.is_admin = true;
    await new Promise((resolve, reject) => {
      req.session.save((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });
    return res.json({ success: true });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to create session" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  if (!req.session) return res.json({ success: true });
  try {
    await new Promise((resolve, reject) => {
      req.session.destroy((error) => {
        if (error) return reject(error);
        return resolve();
      });
    });
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.json({ success: true });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to logout" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.use("/api/scan", requireAdminSession, scanRoutes);

// Protect admin-only endpoints.
app.use(
  ["/api/employees", "/api/logs", "/api/departments"],
  requireAdminSession
);
app.use("/api", adminRoutes);

app.use((req, res) => {
  return res.status(404).json({ error: "route not found" });
});

app.use((error, _req, res, _next) => {
  return res.status(500).json({ error: error.message });
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Startup failed during schema initialisation:", err.message);
    process.exit(1);
  });
