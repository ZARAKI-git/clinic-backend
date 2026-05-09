/**
 * database.js — JSON file-based storage
 * Works on Railway free tier with zero native dependencies.
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "appointments.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ seq: 0, rows: [] }));

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { seq: 0, rows: [] }; }
}

function save(store) { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }
function now()   { return new Date().toISOString(); }
function today() { return new Date().toISOString().split("T")[0]; }

function createAppointment(data) {
  const store = load();
  store.seq += 1;
  const appt = {
    id:               store.seq,
    patient_name:     data.patient_name,
    phone:            data.phone             || "",
    date:             data.date              || today(),
    time:             data.time,
    doctor:           data.doctor            || "Dr. Mehta",
    appointment_type: data.appointment_type  || "General Checkup",
    status:           data.status            || "confirmed",
    notes:            data.notes             || "",
    reminder_sent:    false,
    is_revisit:       data.appointment_type === "Revisit",
    created_at:       now(),
    updated_at:       now(),
  };
  store.rows.push(appt);
  save(store);
  return appt;
}

function getAllAppointments() {
  const { rows } = load();
  return rows.filter(r => r.status !== "cancelled").sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
}

function getAppointmentsByDate(date) {
  const { rows } = load();
  return rows.filter(r => r.date === date && r.status !== "cancelled").sort((a,b) => a.time.localeCompare(b.time));
}

function getAppointmentsByDateAndDoctor(date, doctor) {
  const { rows } = load();
  return rows.filter(r => r.date === date && r.status !== "cancelled" && (!doctor || r.doctor === doctor));
}

function getAppointmentById(id) {
  const { rows } = load();
  return rows.find(r => r.id === Number(id)) || null;
}

function findAppointmentByName(name) {
  const { rows } = load();
  const lower = name.toLowerCase();
  return rows.find(r => r.patient_name.toLowerCase().includes(lower) && !["cancelled","done"].includes(r.status)) || null;
}

function updateAppointmentStatus(id, status) {
  const store = load();
  const appt  = store.rows.find(r => r.id === Number(id));
  if (!appt) return null;
  appt.status = status; appt.updated_at = now();
  save(store); return appt;
}

function updateAppointment(id, data) {
  const store = load();
  const appt  = store.rows.find(r => r.id === Number(id));
  if (!appt) return null;
  Object.assign(appt, {
    ...(data.patient_name     && { patient_name:     data.patient_name }),
    ...(data.phone            && { phone:            data.phone }),
    ...(data.date             && { date:             data.date }),
    ...(data.time             && { time:             data.time }),
    ...(data.doctor           && { doctor:           data.doctor }),
    ...(data.appointment_type && { appointment_type: data.appointment_type }),
    ...(data.status           && { status:           data.status }),
    ...(data.notes            && { notes:            data.notes }),
    updated_at: now(),
  });
  save(store); return appt;
}

function rescheduleAppointment(id, newDate, newTime) {
  const store = load();
  const appt  = store.rows.find(r => r.id === Number(id));
  if (!appt) return null;
  if (newDate) appt.date = newDate;
  if (newTime) appt.time = newTime;
  appt.status = "confirmed"; appt.updated_at = now();
  save(store); return appt;
}

function markReminderSent(id) {
  const store = load();
  const appt  = store.rows.find(r => r.id === Number(id));
  if (!appt) return null;
  appt.reminder_sent = true; appt.updated_at = now();
  save(store); return appt;
}

function getStats() {
  const rows = getAppointmentsByDate(today());
  return {
    total:     rows.length,
    confirmed: rows.filter(r => r.status === "confirmed").length,
    waiting:   rows.filter(r => r.status === "waiting").length,
    done:      rows.filter(r => r.status === "done").length,
    revisits:  rows.filter(r => r.is_revisit).length,
  };
}

module.exports = {
  createAppointment, getAllAppointments, getAppointmentsByDate,
  getAppointmentsByDateAndDoctor, getAppointmentById, findAppointmentByName,
  updateAppointmentStatus, updateAppointment, rescheduleAppointment,
  markReminderSent, getStats,
};
