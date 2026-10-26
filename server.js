
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
  
