const express = require("express");
const path = require("path");
require("dotenv").config();

const scanRoutes = require("./routes/scan");
const adminRoutes = require("./routes/admin");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  return res.redirect("/scanner.html");
});

app.use("/api/scan", scanRoutes);
app.use("/api", adminRoutes);

app.use((req, res) => {
  return res.status(404).json({ error: "route not found" });
});

app.use((error, _req, res, _next) => {
  return res.status(500).json({ error: error.message });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
});
