
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      candidate_id VARCHAR(40) UNIQUE,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(254) NOT NULL,
      phone VARCHAR(40) NOT NULL,
      position VARCHAR(100) NOT NULL,
      photo_data TEXT,
      contribution TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      voter_email VARCHAR(254) NOT NULL,
      position VARCHAR(100) NOT NULL,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (voter_email, position)
    )
  `);
}

function createAdminToken() {
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  const signature = crypto
    .createHmac("sha256", process.env.ADMIN_PASSWORD)
    .update(String(expires))
    .digest("hex");

  return `${expires}.${signature}`;
}

function requireAdmin(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  const expires = Number(parts[0]);
  const signature = parts[1];

  if (!password || !expires || !signature || Date.now() > expires) {
    return res.status(401).json({
      message: "Admin login required or session expired."
    });
  }

  const expected = crypto
    .createHmac("sha256", password)
    .update(String(expires))
    .digest();

  let received;

  try {
    received = Buffer.from(signature, "hex");
  } catch {
    return res.status(401).json({ message: "Invalid admin session." });
  }

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return res.status(401).json({ message: "Invalid admin session." });
  }

  next();
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "KEC Election System server is running"
  });
});

app.get("/api/db-health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS database_time");
    res.json({
      status: "ok",
      message: "PostgreSQL connected successfully",
      databaseTime: result.rows[0].database_time
    });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    res.status(500).json({
      status: "error",
      message: "Database connection failed"
    });
  }
});

app.post("/api/admin/login", (req, res) => {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const suppliedPassword = req.body.password;

  if (
    !expectedPassword ||
    typeof suppliedPassword !== "string" ||
    suppliedPassword !== expectedPassword
  ) {
    return res.status(401).json({
      message: "Incorrect admin password."
    });
  }

  res.json({
    message: "Admin login successful.",
    token: createAdminToken()
  });
});

app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, full_name, email, phone, position,
             contribution, status, created_at
      FROM candidates
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Admin applications error:", error.message);
    res.status(500).json({
      message: "Unable to load applications."
    });
  }
});

app.post("/api/admin/applications/:id/approve", requireAdmin, async (req, res) => {
  try {
    const candidateId =
      `KEC-${new Date().getFullYear()}-` +
      crypto.randomBytes(4).toString("hex").toUpperCase();

    const result = await pool.query(
      `UPDATE candidates
       SET status = 'approved', candidate_id = $1
       WHERE id = $2 AND status = 'pending'
       RETURNING id, candidate_id, full_name, position`,
      [candidateId, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Pending application not found."
      });
    }

    res.json({
      message: "Candidate approved. Email delivery is not configured yet.",
      candidate: result.rows[0]
    });
  } catch (error) {
    console.error("Approval error:", error.message);
    res.status(500).json({
      message: "Unable to approve candidate."
    });
  }
});

app.post("/api/admin/applications/:id/reject", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE candidates
       SET status = 'rejected'
       WHERE id = $1 AND status = 'pending'
       RETURNING id, full_name, status`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Pending application not found."
      });
    }

    res.json({
      message: "Application rejected.",
      application: result.rows[0]
    });
  } catch (error) {
    console.error("Rejection error:", error.message);
    res.status(500).json({
      message: "Unable to reject application."
    });
  }
});

app.get("/api/positions", (req, res) => {
  res.json([
    "President",
    "Vice President",
    "General Secretary",
    "Assistant General Secretary",
    "Treasurer",
    "Financial Secretary",
    "Public Relations Officer (PRO)",
    "Event Coordinator",
    "Welfare Officer",
    "Women Leader",
    "Assistant Women Leader",
    "First Lady",
    "Chief Protocol Officer",
    "Media and Publicity Officer"
  ]);
});

app.get("/api/candidates", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, candidate_id, full_name, position, photo_data
      FROM candidates
      WHERE status = 'approved'
      ORDER BY position, full_name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Candidate list error:", error.message);
    res.status(500).json({ message: "Unable to load candidates." });
  }
});

app.get("/api/results", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.candidate_id, c.full_name, c.position,
             COUNT(v.id)::INTEGER AS vote_count
      FROM candidates c
      LEFT JOIN votes v ON v.candidate_id = c.id
      WHERE c.status = 'approved'
      GROUP BY c.id
      ORDER BY c.position, vote_count DESC, c.full_name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("Results error:", error.message);
    res.status(500).json({ message: "Unable to load results." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`KEC server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Could not initialize database:", error.message);
    process.exit(1);
  });
