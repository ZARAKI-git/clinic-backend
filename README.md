# Clinic Appointment Backend

> A lightweight Node.js backend powering a [Vapi](https://vapi.ai) AI voice receptionist for clinics — books appointments, manages patient records, places callbacks, and ships with a built-in staff dashboard.

<p>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-pg-4169E1?logo=postgresql&logoColor=white">
  <img alt="Vapi" src="https://img.shields.io/badge/Vapi-AI%20Voice-5A31F4">
  <img alt="Railway" src="https://img.shields.io/badge/Deploy-Railway-0B0D0E?logo=railway&logoColor=white">
</p>

## Overview

This service is the backend for an AI phone receptionist built on Vapi. It receives Vapi
webhook events during calls, books and manages appointments against a PostgreSQL database,
can trigger outbound callbacks via the Vapi API, and serves a small set of static dashboards
for staff (login, receptionist, and doctor views).

## Features

- **Vapi webhook handler** — `POST /vapi/webhook` (optionally secured with a shared secret).
- **Appointment management** — create, list, and delete appointments.
- **Patient records & reminders** — retrieve records and send reminders/revisit prompts.
- **Outbound calls** — initiate calls through the Vapi API.
- **Stats endpoint** — quick clinic metrics for the dashboard.
- **Built-in UI** — static `login`, `receptionist`, and `doctor` pages served from `public/`.
- **Health check** — `GET /health` for uptime monitoring.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/` | Serves the login page |
| `POST` | `/vapi/webhook` | Vapi call webhook (validates `x-vapi-secret` if configured) |
| `GET` | `/api/appointments` | List appointments |
| `POST` | `/api/appointments` | Create an appointment |
| `DELETE` | `/api/appointments/:id` | Delete an appointment |
| `POST` | `/api/revisit` | Schedule a revisit |
| `GET` | `/api/patient-records` | List patient records |
| `POST` | `/api/remind/:id` | Send a reminder |
| `GET` | `/api/stats` | Clinic statistics |
| `GET` | `/health` | Health check |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 18+ |
| Server | Express |
| Database | PostgreSQL (`pg`) |
| Realtime | `ws` (WebSocket) |
| Voice AI | Vapi |
| Config | dotenv, CORS |
| Hosting | Railway (`railway.toml`) |

## Getting Started

### Prerequisites
- Node.js 18+
- A PostgreSQL database
- A Vapi account (API key, assistant ID, phone number ID)

### Installation

```bash
git clone https://github.com/ZARAKI-git/clinic-backend.git
cd clinic-backend
npm install
```

### Environment

Create a `.env` file:

```bash
PORT=3000
DATABASE_URL=postgres://user:password@host:5432/dbname
VAPI_WEBHOOK_SECRET=your-shared-secret
VAPI_API_KEY=...
VAPI_ASSISTANT_ID=...
VAPI_PHONE_NUMBER_ID=...
```

### Run

```bash
npm run dev    # development (nodemon, auto-reload)
npm start      # production
```

The server listens on `0.0.0.0:$PORT` and serves the dashboards from `public/`.

## Project Structure

```
server.js      Express app, routes, and Vapi webhook handling
database.js    PostgreSQL access layer
public/        Static dashboards (login, receptionist, doctor, index)
railway.toml   Railway deployment config
```

## Deployment

Deploys to [Railway](https://railway.app) out of the box. Provision a PostgreSQL plugin,
set the environment variables above, and point your Vapi assistant's server URL at
`https://<your-app>/vapi/webhook`.

## License

Proprietary — all rights reserved.
