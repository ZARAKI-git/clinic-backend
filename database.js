/**
 * database.js — PostgreSQL database layer
 * Supports: patient IDs, notes, gender, records search
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id               SERIAL PRIMARY KEY,
      patient_id       TEXT,
      patient_name     TEXT    NOT NULL,
      phone            TEXT    DEFAULT '',
      gender           TEXT    DEFAULT '',
      date             TEXT    NOT NULL,
      time             TEXT    NOT NULL,
      doctor           TEXT    NOT NULL DEFAULT 'Dr. Shittu',
      appointment_type TEXT    NOT NULL DEFAULT 'General Checkup',
      status           TEXT    NOT NULL DEFAULT 'confirmed'
                               CHECK (status IN ('confirmed','waiting','done','cancelled')),
      notes            TEXT    DEFAULT '',
      reminder_sent    BOOLEAN DEFAULT FALSE,
      is_revisit       BOOLEAN DEFAULT FALSE,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_appt_date      ON appointments(date);
    CREATE INDEX IF NOT EXISTS idx_appt_status    ON appointments(status);
    CREATE INDEX IF NOT EXISTS idx_appt_pid       ON appointments(patient_id);
    CREATE INDEX IF NOT EXISTS idx_appt_name      ON appointments(patient_name);
  `);

  // Auto-generate patient_id for existing rows that don't have one
  await pool.query(`
    UPDATE appointments
    SET patient_id = 'RL-' || LPAD(id::TEXT, 4, '0')
    WHERE patient_id IS NULL OR patient_id = ''
  `);

  console.log("✅ Database ready");
}

function today() { return new Date().toISOString().split("T")[0]; }

function rowToObj(row) {
  if (!row) return null;
  return {
    id:               row.id,
    patient_id:       row.patient_id,
    patient_name:     row.patient_name,
    phone:            row.phone,
    gender:           row.gender,
    date:             row.date,
    time:             row.time,
    doctor:           row.doctor,
    appointment_type: row.appointment_type,
    status:           row.status,
    notes:            row.notes,
    reminder_sent:    row.reminder_sent,
    is_revisit:       row.is_revisit,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
  };
}

// Generate next patient ID
async function generatePatientId() {
  const { rows } = await pool.query(`SELECT COUNT(*) as cnt FROM appointments`);
  const num = parseInt(rows[0].cnt) + 1;
  return `RL-${String(num).padStart(4, "0")}`;
}

async function createAppointment(data) {
  const patient_id = await generatePatientId();
  const { rows } = await pool.query(
    `INSERT INTO appointments
       (patient_id, patient_name, phone, gender, date, time, doctor, appointment_type, status, notes, is_revisit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      patient_id,
      data.patient_name,
      data.phone            || "",
      data.gender           || "",
      data.date             || today(),
      data.time,
      data.doctor           || "Dr. Shittu",
      data.appointment_type || "General Checkup",
      data.status           || "confirmed",
      data.notes            || "",
      data.appointment_type === "Revisit",
    ]
  );
  return rowToObj(rows[0]);
}

async function getAllAppointments() {
  const { rows } = await pool.query(
    `SELECT * FROM appointments WHERE status != 'cancelled' ORDER BY date ASC, time ASC`
  );
  return rows.map(rowToObj);
}

async function getAppointmentsByDate(date) {
  const { rows } = await pool.query(
    `SELECT * FROM appointments WHERE date=$1 AND status != 'cancelled' ORDER BY time ASC`,
    [date]
  );
  return rows.map(rowToObj);
}

async function getAppointmentsByDateAndDoctor(date, doctor) {
  if (doctor) {
    const { rows } = await pool.query(
      `SELECT * FROM appointments WHERE date=$1 AND doctor=$2 AND status != 'cancelled'`,
      [date, doctor]
    );
    return rows.map(rowToObj);
  }
  return getAppointmentsByDate(date);
}

async function getAppointmentById(id) {
  const { rows } = await pool.query(`SELECT * FROM appointments WHERE id=$1`, [id]);
  return rowToObj(rows[0]);
}

async function findAppointmentByName(name) {
  const { rows } = await pool.query(
    `SELECT * FROM appointments
     WHERE LOWER(patient_name) LIKE LOWER($1)
       AND status NOT IN ('cancelled','done')
     ORDER BY date ASC, time ASC LIMIT 1`,
    [`%${name}%`]
  );
  return rowToObj(rows[0]);
}

async function updateAppointmentStatus(id, status) {
  const { rows } = await pool.query(
    `UPDATE appointments SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [status, id]
  );
  return rowToObj(rows[0]);
}

async function updateAppointment(id, data) {
  const { rows } = await pool.query(
    `UPDATE appointments SET
       patient_name     = COALESCE($1, patient_name),
       phone            = COALESCE($2, phone),
       gender           = COALESCE($3, gender),
       date             = COALESCE($4, date),
       time             = COALESCE($5, time),
       doctor           = COALESCE($6, doctor),
       appointment_type = COALESCE($7, appointment_type),
       status           = COALESCE($8, status),
       notes            = COALESCE($9, notes),
       updated_at       = NOW()
     WHERE id=$10 RETURNING *`,
    [
      data.patient_name     || null,
      data.phone            || null,
      data.gender           || null,
      data.date             || null,
      data.time             || null,
      data.doctor           || null,
      data.appointment_type || null,
      data.status           || null,
      data.notes            !== undefined ? data.notes : null,
      id,
    ]
  );
  return rowToObj(rows[0]);
}

async function rescheduleAppointment(id, newDate, newTime) {
  const { rows } = await pool.query(
    `UPDATE appointments SET
       date       = COALESCE($1, date),
       time       = COALESCE($2, time),
       status     = 'confirmed',
       updated_at = NOW()
     WHERE id=$3 RETURNING *`,
    [newDate || null, newTime || null, id]
  );
  return rowToObj(rows[0]);
}

async function markReminderSent(id) {
  const { rows } = await pool.query(
    `UPDATE appointments SET reminder_sent=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id]
  );
  return rowToObj(rows[0]);
}

// Search patient records by ID, name, or date
async function searchPatientRecords({ patient_id, name, date }) {
  let query = `SELECT * FROM appointments WHERE 1=1`;
  const params = [];
  let idx = 1;

  if (patient_id) {
    query += ` AND LOWER(patient_id) = LOWER($${idx++})`;
    params.push(patient_id);
  }
  if (name) {
    query += ` AND LOWER(patient_name) LIKE LOWER($${idx++})`;
    params.push(`%${name}%`);
  }
  if (date) {
    query += ` AND date = $${idx++}`;
    params.push(date);
  }

  query += ` ORDER BY date DESC, time DESC`;

  const { rows } = await pool.query(query, params);
  if (!rows.length) return null;

  const visits = rows.map(rowToObj);
  const first = visits[0];

  return {
    patient_name: first.patient_name,
    patient_id:   first.patient_id,
    phone:        first.phone,
    gender:       first.gender,
    visits,
  };
}

async function getStats() {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                                            AS total,
       SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
       SUM(CASE WHEN status='waiting'   THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN status='done'      THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN is_revisit=TRUE    THEN 1 ELSE 0 END) AS revisits
     FROM appointments
     WHERE date=$1 AND status != 'cancelled'`,
    [today()]
  );
  return rows[0];
}

module.exports = {
  init,
  createAppointment,
  getAllAppointments,
  getAppointmentsByDate,
  getAppointmentsByDateAndDoctor,
  getAppointmentById,
  findAppointmentByName,
  updateAppointmentStatus,
  updateAppointment,
  rescheduleAppointment,
  markReminderSent,
  searchPatientRecords,
  getStats,
};
