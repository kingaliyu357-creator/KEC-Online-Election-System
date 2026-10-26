const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");

const nodemailer = require("nodemailer");

const mailer =
  process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD.replace(/\s/g, "")
        }
      })
    : null;

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: "4mb" }));
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

  const received = Buffer.from(signature, "hex");

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return res.status(401).json({
      message: "Invalid admin session."
    });
  }

  next();
}

/* CANDIDATE APPLICATION SUBMISSION */
app.post("/api/applications", async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      position,
      photo,
      contribution,
      pledge
    } = req.body || {};

    if (
      typeof fullName !== "string" || !fullName.trim() ||
      typeof email !== "string" || !email.trim() ||
      typeof phone !== "string" || !phone.trim() ||
      typeof position !== "string" || !position.trim() ||
      typeof contribution !== "string" || !contribution.trim() ||
      pledge !== true
    ) {
      return res.status(400).json({
        message: "Please complete all fields and accept the integrity pledge."
      });
    }

    if (
      typeof photo !== "string" ||
      !/^data:image\/(jpeg|png|webp|gif);base64,/i.test(photo) ||
      photo.length > 2800000
    ) {
      return res.status(400).json({
        message: "Please upload a valid image smaller than 2 MB."
      });
    }

    const result = await pool.query(
      `INSERT INTO candidates
       (full_name, email, phone, position, photo_data, contribution)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, full_name, status, created_at`,
      [
        fullName.trim(),
        email.trim().toLowerCase(),
        phone.trim(),
        position.trim(),
        photo,
        contribution.trim()
      ]
    );

    return res.status(201).json({
      message: "Application submitted successfully. Await admin review.",
      application: result.rows[0]
    });
  } catch (error) {
    console.error("Application submission error:", error.message);
    return res.status(500).json({
      message: "Unable to submit application. Please try again."
    });
  }
});

/* SERVER HEALTH */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "KEC Election System server is running"
  });
});

/* DATABASE HEALTH */
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

/* ADMIN LOGIN */
app.post("/api/admin/login", (req, res) => {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const suppliedPassword = req.body?.password;

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

/* ADMIN: LIST APPLICATIONS INCLUDING CANDIDATE ID */
app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, candidate_id, full_name, email, phone, position,
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

/* ADMIN: APPROVE AND ASSIGN A STABLE CANDIDATE ID */
app.post("/api/admin/applications/:id/approve", requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT id, candidate_id, full_name, position, status
       FROM candidates
       WHERE id = $1
       FOR UPDATE`,
      [req.params.id]
    );

    if (found.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        message: "Application not found."
      });
    }

    const candidate = found.rows[0];

    if (candidate.status === "rejected") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "This application has been rejected."
      });
    }

    let candidateId = candidate.candidate_id;

    if (!candidateId) {
      candidateId =
        `KEC-${new Date().getFullYear()}-` +
        crypto.randomBytes(4).toString("hex").toUpperCase();
    }

    const updated = await client.query(
      `UPDATE candidates
       SET status = 'approved', candidate_id = $1
       WHERE id = $2
       RETURNING id, candidate_id, full_name, position, status`,
      [candidateId, req.params.id]
    );

    await client.query("COMMIT");

    return res.json({
      message: "Candidate approved. Email delivery is not configured yet.",
      candidate: updated.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Approval error:", error.message);
    return res.status(500).json({
      message: "Unable to approve candidate."
    });
  } finally {
    client.release();
  }
});

/* ADMIN: REJECT APPLICATION */
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

/* AVAILABLE POSITIONS */
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

/* APPROVED CANDIDATES */
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
    res.status(500).json({
      message: "Unable to load candidates."
    });
  }
});

/* PUBLIC RESULTS */
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
    res.status(500).json({
      message: "Unable to load results."
    });
  }
});

/* FRONTEND */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* START SERVER */
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
