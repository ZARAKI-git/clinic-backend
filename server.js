require("dotenv").config();
const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const cors      = require("cors");
const path      = require("path");
const db        = require("./database");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT                 = process.env.PORT || 3000;
const VAPI_SECRET          = process.env.VAPI_WEBHOOK_SECRET    || "";
const VAPI_API_KEY         = process.env.VAPI_API_KEY           || "";
const VAPI_ASSISTANT_ID    = process.env.VAPI_ASSISTANT_ID      || "";
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID   || "";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Serve login as default
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

// ── WebSocket ─────────────────────────────────────────────────────────────────
function broadcast(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}

wss.on("connection", async (ws) => {
  console.log("Dashboard connected");
  ws.send(JSON.stringify({ event: "init", data: await db.getAllAppointments(), timestamp: new Date().toISOString() }));
  ws.on("close", () => console.log("Dashboard disconnected"));
});

// ── Reminder Call ─────────────────────────────────────────────────────────────
async function makeReminderCall(appt) {
  if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID || !VAPI_PHONE_NUMBER_ID) return { success: false, reason: "Vapi keys not configured" };
  if (!appt.phone) return { success: false, reason: "No phone number" };
  try {
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { "Authorization": `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: { number: appt.phone, name: appt.patient_name },
        assistantOverrides: {
          firstMessage: `Hello ${appt.patient_name}, this is a reminder from Ray Lawson Family Clinic. You have an appointment with ${appt.doctor} on ${appt.date} at ${appt.time}. Please call us at 905-455-1234 if you need to reschedule. Thank you!`,
        },
      }),
    });
    const data = await res.json();
    return { success: true, call_id: data.id };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ── Reminder Scheduler ────────────────────────────────────────────────────────
function startReminderScheduler() {
  setInterval(async () => {
    const now   = new Date();
    const today = now.toISOString().split("T")[0];
    const appts = await db.getAppointmentsByDate(today);
    for (const appt of appts) {
      if (appt.reminder_sent || appt.status === "cancelled" || !appt.phone) continue;
      const [h, m] = appt.time.split(":").map(Number);
      const apptTime = new Date(); apptTime.setHours(h, m, 0, 0);
      const diffMins = (apptTime - now) / 60000;
      if (diffMins <= 120 && diffMins > 115) {
        const result = await makeReminderCall(appt);
        if (result.success) {
          await db.markReminderSent(appt.id);
          broadcast("reminder_sent", { id: appt.id, patient_name: appt.patient_name });
        }
      }
    }
  }, 60 * 1000);
}

// ── Vapi Webhook ─────────────────────────────────────────────────────────────
app.post("/vapi/webhook", async (req, res) => {
  if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const { message } = req.body;
  if (!message || message.type !== "tool-calls") return res.json({ results: [] });

  const results = [];
  for (const toolCall of message.toolCallList || []) {
    const { id, function: fn } = toolCall;
    const args = fn.arguments || {};
    let result;
    try {
      switch (fn.name) {
        case "book_appointment":       result = await handleBook(args);              break;
        case "cancel_appointment":     result = await handleCancel(args);            break;
        case "reschedule_appointment": result = await handleReschedule(args);        break;
        case "check_availability":     result = await handleCheckAvailability(args); break;
        case "get_appointments":       result = await handleGetAppointments(args);   break;
        default: result = { success: false, message: `Unknown tool: ${fn.name}` };
      }
    } catch (err) { result = { success: false, message: err.message }; }
    results.push({ toolCallId: id, result: JSON.stringify(result) });
  }
  res.json({ results });
});

async function handleBook(args) {
  const { patient_name, date, time, doctor, appointment_type, phone, gender } = args;
  if (!patient_name || !time) return { success: false, message: "Patient name and time required." };
  const appt = await db.createAppointment({
    patient_name, phone: phone || "",
    gender: gender || "",
    date: date || new Date().toISOString().split("T")[0],
    time, doctor: doctor || "Dr. Shittu",
    appointment_type: appointment_type || "General Checkup",
    status: "confirmed",
  });
  broadcast("appointment_booked", appt);
  return { success: true, message: `Booked for ${patient_name} on ${appt.date} at ${time} with ${appt.doctor}. Patient ID: ${appt.patient_id}`, appointment_id: appt.id, patient_id: appt.patient_id };
}

async function handleCancel(args) {
  const appt = args.appointment_id ? await db.getAppointmentById(args.appointment_id) : await db.findAppointmentByName(args.patient_name);
  if (!appt) return { success: false, message: "Appointment not found." };
  await db.updateAppointmentStatus(appt.id, "cancelled");
  broadcast("appointment_cancelled", { ...appt, status: "cancelled" });
  return { success: true, message: `Appointment for ${appt.patient_name} cancelled.` };
}

async function handleReschedule(args) {
  const appt = args.appointment_id ? await db.getAppointmentById(args.appointment_id) : await db.findAppointmentByName(args.patient_name);
  if (!appt) return { success: false, message: "Appointment not found." };
  const updated = await db.rescheduleAppointment(appt.id, args.new_date, args.new_time);
  broadcast("appointment_rescheduled", updated);
  return { success: true, message: `Rescheduled ${appt.patient_name} to ${args.new_date || appt.date} at ${args.new_time}.` };
}

async function handleCheckAvailability(args) {
  const checkDate   = args.date || new Date().toISOString().split("T")[0];
  const booked      = await db.getAppointmentsByDateAndDoctor(checkDate, args.doctor);
  const allSlots    = generateTimeSlots();
  const bookedTimes = booked.map(a => a.time);
  return { success: true, date: checkDate, available_slots: allSlots.filter(s => !bookedTimes.includes(s)), booked_slots: bookedTimes };
}

async function handleGetAppointments(args) {
  const queryDate = args.date || new Date().toISOString().split("T")[0];
  const appts = await db.getAppointmentsByDate(queryDate);
  return { success: true, date: queryDate, count: appts.length, appointments: appts.map(a => ({ id: a.id, patient: a.patient_name, patient_id: a.patient_id, time: a.time, doctor: a.doctor, status: a.status })) };
}

function generateTimeSlots() {
  const slots = [];
  for (let h = 9; h <= 17; h++) {
    slots.push(`${String(h).padStart(2,"0")}:00`);
    if (h < 17) slots.push(`${String(h).padStart(2,"0")}:30`);
  }
  return slots;
}

// ── REST API ──────────────────────────────────────────────────────────────────
app.get("/api/appointments", async (req, res) => {
  const appts = req.query.date ? await db.getAppointmentsByDate(req.query.date) : await db.getAllAppointments();
  res.json(appts);
});

app.post("/api/appointments", async (req, res) => {
  const appt = await db.createAppointment(req.body);
  broadcast("appointment_booked", appt);
  res.json(appt);
});

app.patch("/api/appointments/:id", async (req, res) => {
  const appt = await db.updateAppointment(req.params.id, req.body);
  if (!appt) return res.status(404).json({ error: "Not found" });
  broadcast("appointment_updated", appt);
  res.json(appt);
});

app.delete("/api/appointments/:id", async (req, res) => {
  await db.updateAppointmentStatus(req.params.id, "cancelled");
  broadcast("appointment_cancelled", { id: req.params.id, status: "cancelled" });
  res.json({ success: true });
});

app.post("/api/revisit", async (req, res) => {
  const { appointment_id, revisit_date, revisit_time, notes } = req.body;
  const original = await db.getAppointmentById(appointment_id);
  if (!original) return res.status(404).json({ error: "Original appointment not found" });
  const revisit = await db.createAppointment({
    patient_name: original.patient_name, phone: original.phone,
    gender: original.gender,
    date: revisit_date, time: revisit_time || original.time,
    doctor: original.doctor, appointment_type: "Revisit", status: "confirmed",
    notes: notes || `Revisit from appointment #${appointment_id}`,
  });
  broadcast("appointment_booked", revisit);
  const reminderResult = await makeReminderCall(revisit);
  res.json({ success: true, revisit, reminder: reminderResult, message: `Revisit scheduled for ${original.patient_name} on ${revisit_date}.` });
});

// Patient records search
app.get("/api/patient-records", async (req, res) => {
  const { patient_id, name, date } = req.query;
  if (!patient_id && !name && !date) return res.status(400).json({ error: "Provide patient_id, name, or date" });
  const result = await db.searchPatientRecords({ patient_id, name, date });
  if (!result) return res.status(404).json({ error: "No records found" });
  res.json(result);
});

app.post("/api/remind/:id", async (req, res) => {
  const appt = await db.getAppointmentById(req.params.id);
  if (!appt) return res.status(404).json({ error: "Not found" });
  const result = await makeReminderCall(appt);
  if (result.success) await db.markReminderSent(appt.id);
  res.json(result);
});

app.get("/api/stats", async (_req, res) => res.json(await db.getStats()));
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  await db.init();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ Ray Lawson Clinic server running on port ${PORT}`);
    console.log(`🏥 Login:    http://localhost:${PORT}/login.html`);
    console.log(`🤖 Webhook:  POST /vapi/webhook`);
    console.log(`💚 Health:   GET  /health`);
    startReminderScheduler();
  });
}

start().catch(err => { console.error("Failed to start:", err); process.exit(1); });
