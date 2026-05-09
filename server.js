/**
 * Clinic Appointment Backend
 * Connects Vapi AI Receptionist → JSON DB → Live Dashboard (WebSocket)
 * Features: Book, Cancel, Reschedule, Revisit scheduling, Reminder calls via Vapi
 */

require("dotenv").config();
const express  = require("express");
const http     = require("http");
const WebSocket = require("ws");
const cors     = require("cors");
const path     = require("path");
const db       = require("./database");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT         = process.env.PORT || 3000;
const VAPI_SECRET  = process.env.VAPI_WEBHOOK_SECRET || "";
const VAPI_API_KEY = process.env.VAPI_API_KEY || "";
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || "";
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || "";

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

wss.on("connection", (ws) => {
  console.log("Dashboard connected");
  ws.send(JSON.stringify({
    event: "init",
    data: db.getAllAppointments(),
    timestamp: new Date().toISOString(),
  }));
  ws.on("close", () => console.log("Dashboard disconnected"));
});

// ─── Vapi Outbound Call (reminder) ───────────────────────────────────────────
async function makeReminderCall(appt) {
  if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID || !VAPI_PHONE_NUMBER_ID) {
    console.log("Vapi keys not configured — skipping reminder call");
    return { success: false, reason: "Vapi keys not configured" };
  }
  if (!appt.phone) {
    return { success: false, reason: "No phone number for patient" };
  }

  try {
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${VAPI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: {
          number: appt.phone,
          name: appt.patient_name,
        },
        assistantOverrides: {
          firstMessage: `Hello ${appt.patient_name}, this is a reminder call from MediCare Clinic. You have an appointment scheduled with ${appt.doctor} on ${appt.date} at ${appt.time}. Please confirm your attendance or call us to reschedule. Thank you!`,
          variableValues: {
            patient_name: appt.patient_name,
            doctor: appt.doctor,
            date: appt.date,
            time: appt.time,
          },
        },
      }),
    });

    const data = await res.json();
    console.log("Reminder call initiated:", data.id);
    return { success: true, call_id: data.id };
  } catch (err) {
    console.error("Reminder call failed:", err.message);
    return { success: false, reason: err.message };
  }
}

// ─── Schedule reminder checker (runs every minute) ───────────────────────────
function startReminderScheduler() {
  setInterval(async () => {
    const now   = new Date();
    const today = now.toISOString().split("T")[0];
    const appts = db.getAppointmentsByDate(today);

    for (const appt of appts) {
      if (appt.reminder_sent || appt.status === "cancelled" || !appt.phone) continue;

      // Call 2 hours before appointment
      const [h, m]    = appt.time.split(":").map(Number);
      const apptTime  = new Date();
      apptTime.setHours(h, m, 0, 0);
      const diffMins  = (apptTime - now) / 60000;

      if (diffMins <= 120 && diffMins > 115) {
        console.log(`Sending reminder to ${appt.patient_name}`);
        const result = await makeReminderCall(appt);
        if (result.success) {
          db.markReminderSent(appt.id);
          broadcast("reminder_sent", { id: appt.id, patient_name: appt.patient_name });
        }
      }
    }
  }, 60 * 1000); // every minute
}

// ─── VAPI WEBHOOK ─────────────────────────────────────────────────────────────
app.post("/vapi/webhook", (req, res) => {
  if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { message } = req.body;
  if (!message || message.type !== "tool-calls") {
    return res.json({ results: [] });
  }

  const results = [];

  for (const toolCall of message.toolCallList || []) {
    const { id, function: fn } = toolCall;
    const args = fn.arguments || {};
    let result;

    console.log(`Vapi tool: ${fn.name}`, args);

    switch (fn.name) {
      case "book_appointment":        result = handleBook(args);             break;
      case "cancel_appointment":      result = handleCancel(args);           break;
      case "reschedule_appointment":  result = handleReschedule(args);       break;
      case "check_availability":      result = handleCheckAvailability(args);break;
      case "get_appointments":        result = handleGetAppointments(args);  break;
      default: result = { success: false, message: `Unknown tool: ${fn.name}` };
    }

    results.push({ toolCallId: id, result: JSON.stringify(result) });
  }

  res.json({ results });
});

// ─── Tool Handlers ────────────────────────────────────────────────────────────
function handleBook(args) {
  const { patient_name, date, time, doctor, appointment_type, phone } = args;
  if (!patient_name || !time) return { success: false, message: "Patient name and time required." };

  const appt = db.createAppointment({
    patient_name, phone: phone || "",
    date: date || new Date().toISOString().split("T")[0],
    time, doctor: doctor || "Dr. Mehta",
    appointment_type: appointment_type || "General Checkup",
    status: "confirmed",
  });

  broadcast("appointment_booked", appt);
  return { success: true, message: `Booked for ${patient_name} on ${appt.date} at ${time} with ${appt.doctor}.`, appointment_id: appt.id };
}

function handleCancel(args) {
  const appt = args.appointment_id ? db.getAppointmentById(args.appointment_id) : db.findAppointmentByName(args.patient_name);
  if (!appt) return { success: false, message: "Appointment not found." };
  db.updateAppointmentStatus(appt.id, "cancelled");
  broadcast("appointment_cancelled", { ...appt, status: "cancelled" });
  return { success: true, message: `Appointment for ${appt.patient_name} cancelled.` };
}

function handleReschedule(args) {
  const appt = args.appointment_id ? db.getAppointmentById(args.appointment_id) : db.findAppointmentByName(args.patient_name);
  if (!appt) return { success: false, message: "Appointment not found." };
  const updated = db.rescheduleAppointment(appt.id, args.new_date, args.new_time);
  broadcast("appointment_rescheduled", updated);
  return { success: true, message: `Rescheduled ${appt.patient_name} to ${args.new_date || appt.date} at ${args.new_time}.` };
}

function handleCheckAvailability(args) {
  const checkDate = args.date || new Date().toISOString().split("T")[0];
  const booked    = db.getAppointmentsByDateAndDoctor(checkDate, args.doctor);
  const allSlots  = generateTimeSlots();
  const bookedTimes = booked.map((a) => a.time);
  return { success: true, date: checkDate, available_slots: allSlots.filter(s => !bookedTimes.includes(s)), booked_slots: bookedTimes };
}

function handleGetAppointments(args) {
  const queryDate = args.date || new Date().toISOString().split("T")[0];
  const appts = db.getAppointmentsByDate(queryDate);
  return { success: true, date: queryDate, count: appts.length, appointments: appts.map(a => ({ id: a.id, patient: a.patient_name, time: a.time, doctor: a.doctor, status: a.status })) };
}

function generateTimeSlots() {
  const slots = [];
  for (let h = 9; h <= 17; h++) {
    slots.push(`${String(h).padStart(2,"0")}:00`);
    if (h < 17) slots.push(`${String(h).padStart(2,"0")}:30`);
  }
  return slots;
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get("/api/appointments", (req, res) => {
  const appts = req.query.date ? db.getAppointmentsByDate(req.query.date) : db.getAllAppointments();
  res.json(appts);
});

app.post("/api/appointments", (req, res) => {
  const appt = db.createAppointment(req.body);
  broadcast("appointment_booked", appt);
  res.json(appt);
});

app.patch("/api/appointments/:id", (req, res) => {
  const appt = db.updateAppointment(req.params.id, req.body);
  if (!appt) return res.status(404).json({ error: "Not found" });
  broadcast("appointment_updated", appt);
  res.json(appt);
});

app.delete("/api/appointments/:id", (req, res) => {
  db.updateAppointmentStatus(req.params.id, "cancelled");
  broadcast("appointment_cancelled", { id: req.params.id, status: "cancelled" });
  res.json({ success: true });
});

// ─── REVISIT API ──────────────────────────────────────────────────────────────
// Doctor schedules a revisit for a patient — creates new future appointment + reminder call
app.post("/api/revisit", async (req, res) => {
  const { appointment_id, revisit_date, revisit_time, notes } = req.body;

  const original = db.getAppointmentById(appointment_id);
  if (!original) return res.status(404).json({ error: "Original appointment not found" });

  // Create new revisit appointment
  const revisit = db.createAppointment({
    patient_name:     original.patient_name,
    phone:            original.phone,
    date:             revisit_date,
    time:             revisit_time || original.time,
    doctor:           original.doctor,
    appointment_type: "Revisit",
    status:           "confirmed",
    notes:            notes || `Revisit from appointment #${appointment_id}`,
  });

  broadcast("appointment_booked", revisit);

  // Schedule reminder call for the revisit day
  const reminderResult = await makeReminderCall(revisit);

  res.json({
    success: true,
    revisit,
    reminder: reminderResult,
    message: `Revisit scheduled for ${original.patient_name} on ${revisit_date}. ${reminderResult.success ? "Reminder call will be made on that day." : "Note: configure Vapi keys for automatic reminder calls."}`,
  });
});

// ─── Manual reminder trigger (for testing) ────────────────────────────────────
app.post("/api/remind/:id", async (req, res) => {
  const appt = db.getAppointmentById(req.params.id);
  if (!appt) return res.status(404).json({ error: "Not found" });
  const result = await makeReminderCall(appt);
  if (result.success) db.markReminderSent(appt.id);
  res.json(result);
});

app.get("/api/stats", (req, res) => res.json(db.getStats()));
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Clinic server running on port ${PORT}`);
  console.log(`📡 WebSocket ready`);
  console.log(`🤖 Vapi webhook: POST /vapi/webhook`);
  console.log(`📅 Revisit API: POST /api/revisit`);
  console.log(`💚 Health: GET /health`);
  startReminderScheduler();
  console.log(`⏰ Reminder scheduler started`);
});}

wss.on("connection", (ws) => {
  console.log("Dashboard connected via WebSocket");
  // Send current appointments on connect
  ws.send(JSON.stringify({
    event: "init",
    data: db.getAllAppointments(),
    timestamp: new Date().toISOString(),
  }));

  ws.on("close", () => console.log("Dashboard disconnected"));
});

// ─── VAPI WEBHOOK ─────────────────────────────────────────────────────────────
// Add this URL in Vapi Dashboard → Assistant → Tools → Webhook URL
// e.g. https://your-server.com/vapi/webhook
app.post("/vapi/webhook", (req, res) => {
  // Optional: verify secret header from Vapi
  if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { message } = req.body;
  if (!message || message.type !== "tool-calls") {
    return res.json({ results: [] });
  }

  const results = [];

  for (const toolCall of message.toolCallList || []) {
    const { id, function: fn } = toolCall;
    const args = fn.arguments || {};
    let result;

    console.log(`Vapi tool call: ${fn.name}`, args);

    switch (fn.name) {
      case "book_appointment":
        result = handleBook(args);
        break;
      case "cancel_appointment":
        result = handleCancel(args);
        break;
      case "reschedule_appointment":
        result = handleReschedule(args);
        break;
      case "check_availability":
        result = handleCheckAvailability(args);
        break;
      case "get_appointments":
        result = handleGetAppointments(args);
        break;
      default:
        result = { success: false, message: `Unknown tool: ${fn.name}` };
    }

    results.push({ toolCallId: id, result: JSON.stringify(result) });
  }

  res.json({ results });
});

// ─── Tool Handlers ────────────────────────────────────────────────────────────
function handleBook(args) {
  const { patient_name, date, time, doctor, appointment_type, phone } = args;

  if (!patient_name || !time) {
    return { success: false, message: "Patient name and time are required." };
  }

  const appt = db.createAppointment({
    patient_name,
    date: date || new Date().toISOString().split("T")[0],
    time,
    doctor: doctor || "Dr. Mehta",
    appointment_type: appointment_type || "General Checkup",
    phone: phone || "",
    status: "confirmed",
  });

  broadcast("appointment_booked", appt);

  return {
    success: true,
    message: `Appointment booked for ${patient_name} on ${appt.date} at ${time} with ${appt.doctor}.`,
    appointment_id: appt.id,
  };
}

function handleCancel(args) {
  const { appointment_id, patient_name } = args;

  let appt;
  if (appointment_id) {
    appt = db.getAppointmentById(appointment_id);
  } else if (patient_name) {
    appt = db.findAppointmentByName(patient_name);
  }

  if (!appt) {
    return { success: false, message: "Appointment not found." };
  }

  db.updateAppointmentStatus(appt.id, "cancelled");
  broadcast("appointment_cancelled", { ...appt, status: "cancelled" });

  return {
    success: true,
    message: `Appointment for ${appt.patient_name} at ${appt.time} has been cancelled.`,
  };
}

function handleReschedule(args) {
  const { appointment_id, patient_name, new_date, new_time } = args;

  let appt;
  if (appointment_id) {
    appt = db.getAppointmentById(appointment_id);
  } else if (patient_name) {
    appt = db.findAppointmentByName(patient_name);
  }

  if (!appt) {
    return { success: false, message: "Appointment not found." };
  }

  const updated = db.rescheduleAppointment(appt.id, new_date, new_time);
  broadcast("appointment_rescheduled", updated);

  return {
    success: true,
    message: `Appointment for ${appt.patient_name} rescheduled to ${new_date || appt.date} at ${new_time}.`,
  };
}

function handleCheckAvailability(args) {
  const { date, doctor } = args;
  const checkDate = date || new Date().toISOString().split("T")[0];

  const booked = db.getAppointmentsByDateAndDoctor(checkDate, doctor);
  const allSlots = generateTimeSlots();
  const bookedTimes = booked.map((a) => a.time);
  const available = allSlots.filter((s) => !bookedTimes.includes(s));

  return {
    success: true,
    date: checkDate,
    doctor: doctor || "Any",
    available_slots: available,
    booked_slots: bookedTimes,
  };
}

function handleGetAppointments(args) {
  const { date } = args;
  const queryDate = date || new Date().toISOString().split("T")[0];
  const appts = db.getAppointmentsByDate(queryDate);

  return {
    success: true,
    date: queryDate,
    count: appts.length,
    appointments: appts.map((a) => ({
      id: a.id,
      patient: a.patient_name,
      time: a.time,
      doctor: a.doctor,
      type: a.appointment_type,
      status: a.status,
    })),
  };
}

function generateTimeSlots() {
  const slots = [];
  for (let h = 9; h <= 17; h++) {
    slots.push(`${String(h).padStart(2, "0")}:00`);
    if (h < 17) slots.push(`${String(h).padStart(2, "0")}:30`);
  }
  return slots;
}

// ─── REST API (for dashboard) ─────────────────────────────────────────────────
app.get("/api/appointments", (req, res) => {
  const { date } = req.query;
  const appts = date ? db.getAppointmentsByDate(date) : db.getAllAppointments();
  res.json(appts);
});

app.post("/api/appointments", (req, res) => {
  const appt = db.createAppointment(req.body);
  broadcast("appointment_booked", appt);
  res.json(appt);
});

app.patch("/api/appointments/:id", (req, res) => {
  const { id } = req.params;
  const appt = db.updateAppointment(id, req.body);
  if (!appt) return res.status(404).json({ error: "Not found" });
  broadcast("appointment_updated", appt);
  res.json(appt);
});

app.delete("/api/appointments/:id", (req, res) => {
  db.updateAppointmentStatus(req.params.id, "cancelled");
  broadcast("appointment_cancelled", { id: req.params.id, status: "cancelled" });
  res.json({ success: true });
});

app.get("/api/stats", (req, res) => {
  res.json(db.getStats());
});

// ─── Health check (Railway uses this to confirm the app is alive) ────────────
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ Clinic server running on port ${PORT}`);
  console.log(`📡 WebSocket ready for dashboard connections`);
  console.log(`🤖 Vapi webhook: POST /vapi/webhook`);
  console.log(`💚 Health check: GET /health`);
});
