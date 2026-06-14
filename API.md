# WA Service — API Documentation

A standalone WhatsApp gateway built on [Baileys](https://github.com/WhiskeySockets/Baileys).
It is **framework-agnostic**: it talks to your application over plain HTTP (REST +
Socket.io + an outbound webhook), so it works with Laravel, a MERN/Express app,
Django, Rails, or anything that can make HTTP calls.

The typical pattern: **run one instance of this service per application**, each
with its own `PORT`, `AUTH_DIR`, `WEBHOOK_URL`, and `API_KEY`.

---

## Table of contents

1. [Concepts](#concepts)
2. [Configuration](#configuration)
3. [Authentication](#authentication)
4. [REST endpoints](#rest-endpoints)
5. [Socket.io real-time events](#socketio-real-time-events)
6. [Outbound webhook (service → your backend)](#outbound-webhook-service--your-backend)
7. [Integration recipes](#integration-recipes)
8. [Running multiple apps](#running-multiple-apps)
9. [Errors & status reference](#errors--status-reference)

---

## Concepts

| Term | Meaning |
|------|---------|
| **session / `sessionId`** | One logged-in WhatsApp account. You choose the id (e.g. a user id, tenant id, `"default"`). Credentials are stored under `AUTH_DIR/<sessionId>/`. |
| **status** | `disconnected` → `connecting` → `connected`. While `connecting`, a QR code is available to scan. |
| **QR** | Returned as a base64 PNG data URL (`data:image/png;base64,...`) — render it directly in an `<img src>`. |
| **webhook** | An endpoint *in your app* that this service POSTs events to. |

A session lifecycle:

```
start-session ──► connecting ──► (scan QR) ──► connected
                      ▲                            │
                      └──────── auto-reconnect ◄───┘
```

---

## Configuration

All config is via environment variables (`.env`). See [.env.example](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5013` | Port the service listens on. |
| `AUTH_DIR` | `auth` | Folder for stored WhatsApp credentials. |
| `WEBHOOK_URL` | *(empty)* | Your backend endpoint for events. Empty = disabled. |
| `WEBHOOK_SECRET` | *(empty)* | Sent as `X-Webhook-Secret` header so you can verify webhook authenticity. |
| `FORWARD_INBOUND` | `false` | `true` forwards incoming WhatsApp messages to the webhook. |
| `API_KEY` | *(empty)* | When set, REST calls must send a matching `X-API-Key`. |
| `CORS_ORIGIN` | `*` | Restrict browser CORS to your frontend origin. |

> `LARAVEL_WEBHOOK_URL` is still read as a fallback for `WEBHOOK_URL` (backward compatible).

---

## Authentication

Authentication is **optional** and off by default. When `API_KEY` is set, every
REST request must include it:

```
X-API-Key: <your-key>
```

or as a query param: `?apiKey=<your-key>`.

`GET /health` is always public. CORS preflight (`OPTIONS`) is always allowed.

Missing/invalid key → `401`:

```json
{ "success": false, "message": "Invalid or missing API key" }
```

---

## REST endpoints

Base URL: `http://<host>:<PORT>`
All request/response bodies are JSON. All `POST` bodies require `Content-Type: application/json`.

### `GET /health`

Liveness probe. Always public.

**200**
```json
{ "status": "ok", "service": "wa-service", "uptime": 123.45 }
```

---

### `POST /start-session`

Start a new session or resume an existing one. Idempotent — safe to call on every
page load. If not yet connected, this triggers QR generation (delivered via
Socket.io and `GET /get-qr`).

**Request**
```json
{ "sessionId": "user-42" }
```

**200**
```json
{ "success": true, "message": "Session starting" }
```

**400** — `sessionId` missing
```json
{ "error": "sessionId required" }
```

---

### `GET /session-status/:sessionId`

Current status of a session.

**200**
```json
{ "status": "connected", "phone": "919876543210" }
```

`status` is one of `disconnected` | `connecting` | `connected`.
`phone` is `null` until connected. If the session is unknown: `{ "status": "disconnected" }`.

---

### `GET /get-qr/:sessionId`

Fetch the current QR as a base64 PNG data URL. Useful for the initial page render
before the Socket.io connection is established. Returns `null` once connected.

**200**
```json
{ "qr": "data:image/png;base64,iVBORw0KGgoAAA..." }
```
or
```json
{ "qr": null }
```

---

### `POST /api/send-message`

Send a text message.

**Request**
```json
{ "sessionId": "user-42", "number": "919876543210", "message": "Hello!" }
```
`number` may be any format — non-digits are stripped and `@s.whatsapp.net` is appended automatically.

**200** — `{ "success": true }`
**404** — session not connected
**500** — send failure (`{ "success": false, "message": "<error>" }`)

---

### `POST /api/send-media`

Send a single media file by URL (currently sent as a PDF document).

**Request**
```json
{
  "sessionId": "user-42",
  "number": "919876543210",
  "mediaUrl": "https://example.com/invoice.pdf",
  "caption": "Your invoice"
}
```
`caption` is optional.

**200** — `{ "success": true }`  ·  **404** / **500** as above.

---

### `POST /api/send-multi-media`

Send several media files sequentially.

**Request**
```json
{
  "sessionId": "user-42",
  "number": "919876543210",
  "mediaUrls": ["https://example.com/a.pdf", "https://example.com/b.pdf"],
  "caption": "Documents"
}
```

**200** — `{ "success": true }` (after all sent)  ·  **404** / **500** as above.

---

### `POST /api/send-bulk-message`

Send the same text to many numbers. **Responds immediately**; per-number progress
is streamed over Socket.io (see below). A 500ms delay is applied between sends.

**Request**
```json
{
  "sessionId": "user-42",
  "numbers": ["919876543210", "919812345678"],
  "message": "Announcement"
}
```

**200** (immediate)
```json
{ "success": true, "message": "Bulk send started" }
```
Track completion via the `whatsapp-bulk-message-status-<sessionId>` socket event.

---

## Socket.io real-time events

Connect to the same host/port. Path: `/socket.io` (the default).

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:5013');

socket.on('connect', () => socket.emit('join', 'user-42')); // sessionId
```

After `join`, the server immediately pushes the current status (and QR if not
connected). All event names are **suffixed with the sessionId**.

| Event | Payload | Fires when |
|-------|---------|-----------|
| `whatsapp-status-<sessionId>` | `{ status, phone? }` | Status changes / on join |
| `whatsapp-qr-<sessionId>` | `{ qr }` (base64 data URL) | A new QR is generated |
| `whatsapp-bulk-message-status-<sessionId>` | `{ status, progress, total, sent }` | During/after a bulk send |

Bulk `status` values: `sent` (per number), `failed` (per number), `completed` (final).
`progress` is 0–100.

**Client example**
```js
const id = 'user-42';
socket.on(`whatsapp-qr-${id}`,     ({ qr })     => { qrImg.src = qr; });
socket.on(`whatsapp-status-${id}`, ({ status, phone }) => updateUi(status, phone));
socket.on(`whatsapp-bulk-message-status-${id}`, (p) => console.log(p.sent, '/', p.total));
```

---

## Outbound webhook (service → your backend)

If `WEBHOOK_URL` is set, the service POSTs JSON to it on key events. This lets your
backend persist status, trigger flows, etc. — even when no browser is connected.

**Headers**
```
Content-Type: application/json
X-Webhook-Secret: <WEBHOOK_SECRET>   ← only if WEBHOOK_SECRET is configured
```

**Payloads**

Connected:
```json
{ "event": "connected", "sessionId": "user-42", "status": "connected", "phone": "919876543210" }
```

Disconnected (logged out from the phone):
```json
{ "event": "disconnected", "sessionId": "user-42", "status": "disconnected" }
```

Inbound message (only when `FORWARD_INBOUND=true`):
```json
{
  "event": "message",
  "sessionId": "user-42",
  "from": "919876543210",
  "text": "Customer reply text",
  "messageId": "3EB0...",
  "timestamp": 1718352000
}
```

Your endpoint should return `2xx`. Failures are ignored (fire-and-forget, 5s timeout).

---

## Integration recipes

### MERN / Express backend

```js
// Send a message from your Node backend
import axios from 'axios';

const WA = axios.create({
  baseURL: process.env.WA_SERVICE_URL,            // http://localhost:5013
  headers: { 'X-API-Key': process.env.WA_API_KEY } // if API_KEY is set
});

await WA.post('/start-session', { sessionId: req.user.id });
await WA.post('/api/send-message', {
  sessionId: req.user.id, number: '919876543210', message: 'Hi from MERN!'
});

// Receive events
app.post('/api/whatsapp/webhook', express.json(), (req, res) => {
  if (req.get('X-Webhook-Secret') !== process.env.WA_WEBHOOK_SECRET) return res.sendStatus(401);
  const { event, sessionId, status, from, text } = req.body;
  // ...persist / react...
  res.sendStatus(200);
});
```

React frontend uses the [Socket.io](#socketio-real-time-events) snippet above to
show the QR and live status.

### Laravel backend (current setup)

```php
Http::withHeaders(['X-API-Key' => config('services.wa.key')])
    ->post(config('services.wa.url').'/api/send-message', [
        'sessionId' => $user->id,
        'number'    => $number,
        'message'   => $text,
    ]);
```

Route the webhook to a controller that verifies `X-Webhook-Secret` and updates the
user's WhatsApp status.

### Any other stack

Anything that can make an HTTP POST works. Use the REST endpoints to send, expose
one route to receive the webhook, and (optionally) a Socket.io client for live QR.

---

## Running multiple apps

Each application gets its own isolated instance. Example with two apps on one box:

```bash
# App A (Laravel)
PORT=5013 AUTH_DIR=auth_laravel API_KEY=keyA \
WEBHOOK_URL=https://laravel.example.com/api/whatsapp/webhook node index.js

# App B (MERN)
PORT=5014 AUTH_DIR=auth_mern API_KEY=keyB \
WEBHOOK_URL=https://mern.example.com/api/wa/webhook node index.js
```

Keep `AUTH_DIR` distinct so credentials never collide. With a process manager:

```bash
pm2 start index.js --name wa-laravel -- # (env from its own .env)
pm2 start index.js --name wa-mern    -- # (env from a different .env)
```

> Within a single instance, sessions are already isolated by `sessionId`. Run
> separate instances only when you want separate config (webhook, key, port) per app.

---

## Errors & status reference

| HTTP | Meaning |
|------|---------|
| `200` | Success |
| `400` | Bad request (e.g. missing `sessionId`) |
| `401` | Missing/invalid `X-API-Key` (only when `API_KEY` is set) |
| `404` | Session not connected — start it and scan the QR first |
| `500` | Send/internal failure; see `message` |

Connection statuses: `disconnected` · `connecting` · `connected`.
On logout the service auto-clears credentials and regenerates a QR; on transient
drops it auto-reconnects.
