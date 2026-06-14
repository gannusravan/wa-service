import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { startSession, getStatus, getQr, getSocket, restoreAll } from './sessionManager.js';

const app = express();
app.use(express.json());

// Allow browser requests from your app's frontend → this Node.js service.
// Set CORS_ORIGIN to lock it down (e.g. https://app.example.com); defaults to *.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Optional API-key auth. When API_KEY is set, every request must send a matching
// X-API-Key header (or ?apiKey=). Leave API_KEY unset to keep it open (current
// behaviour). GET /health is always public.
const API_KEY = process.env.API_KEY || '';
app.use((req, res, next) => {
    if (!API_KEY) return next();
    if (req.path === '/health') return next();
    const provided = req.get('X-API-Key') || req.query.apiKey;
    if (provided === API_KEY) return next();
    return res.status(401).json({ success: false, message: 'Invalid or missing API key' });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*' },
    path: '/socket.io',
});

const PORT = process.env.PORT || 5013;

// ── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        const id = String(userId);
        socket.join(id);

        // Push the current authoritative state to the freshly (re)loaded page so
        // a refresh always reflects reality, instead of relying on stale
        // server-rendered HTML or a change event that already fired.
        const { status, phone } = getStatus(id);
        socket.emit(`whatsapp-status-${id}`, { status, phone });
        if (status !== 'connected') {
            const qr = getQr(id);
            if (qr) socket.emit(`whatsapp-qr-${id}`, { qr });
        }
    });
});

// Override io.emit to also broadcast to the named room so Socket.io room-join
// and global-emit both work.
const originalEmit = io.emit.bind(io);
io.emit = (event, ...args) => {
    originalEmit(event, ...args);
};

// ── REST API ─────────────────────────────────────────────────────────────────

// Health check (always public — useful for uptime monitors / orchestrators)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'wa-service', uptime: process.uptime() });
});

// Start or resume a session
app.post('/start-session', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    await startSession(String(sessionId), io);
    res.json({ success: true, message: 'Session starting' });
});

// Session status
app.get('/session-status/:sessionId', (req, res) => {
    const result = getStatus(req.params.sessionId);
    res.json(result);
});

// Get current QR (for initial page load before Socket.io connects)
app.get('/get-qr/:sessionId', (req, res) => {
    const qr = getQr(req.params.sessionId);
    if (qr) return res.json({ qr });
    res.json({ qr: null });
});

// ── Shared send guard ─────────────────────────────────────────────────────────
function requireConnected(sessionId, res) {
    const { status } = getStatus(String(sessionId));
    const sock = getSocket(String(sessionId));
    console.log(`[WA] send guard  sessionId=${sessionId}  status=${status}  hasSocket=${!!sock}`);
    if (!sock || status !== 'connected') {
        res.status(404).json({ success: false, message: `Session not connected (status: ${status})` });
        return null;
    }
    return sock;
}

// Send a text message
app.post('/api/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    console.log(`[WA] /api/send-message  sessionId=${sessionId}  number=${number}`);
    const sock = requireConnected(sessionId, res);
    if (!sock) return;

    try {
        const jid = toJid(number);
        console.log(`[WA] sending text → ${jid}`);
        const result = await sock.sendMessage(jid, { text: message });
        console.log(`[WA] sent  id=${result?.key?.id}`);
        res.json({ success: true });
    } catch (e) {
        console.error(`[WA] send-message error: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Send a single media file (URL)
app.post('/api/send-media', async (req, res) => {
    const { sessionId, number, mediaUrl, caption = '' } = req.body;
    console.log(`[WA] /api/send-media  sessionId=${sessionId}  number=${number}`);
    const sock = requireConnected(sessionId, res);
    if (!sock) return;

    try {
        const jid = toJid(number);
        console.log(`[WA] sending media → ${jid}  url=${mediaUrl}`);
        await sock.sendMessage(jid, {
            document: { url: mediaUrl },
            mimetype: 'application/pdf',
            caption,
            fileName: 'invoice.pdf',
        });
        res.json({ success: true });
    } catch (e) {
        console.error(`[WA] send-media error: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Send multiple media files (array of URLs)
app.post('/api/send-multi-media', async (req, res) => {
    const { sessionId, number, mediaUrls = [], caption = '' } = req.body;
    console.log(`[WA] /api/send-multi-media  sessionId=${sessionId}  number=${number}  count=${mediaUrls.length}`);
    const sock = requireConnected(sessionId, res);
    if (!sock) return;

    try {
        const jid = toJid(number);
        for (const url of mediaUrls) {
            console.log(`[WA] sending media → ${jid}  url=${url}`);
            await sock.sendMessage(jid, {
                document: { url },
                mimetype: 'application/pdf',
                caption,
                fileName: 'invoice.pdf',
            });
        }
        res.json({ success: true });
    } catch (e) {
        console.error(`[WA] send-multi-media error: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Send a bulk text message to multiple numbers with progress events
app.post('/api/send-bulk-message', async (req, res) => {
    const { sessionId, numbers = [], message } = req.body;
    console.log(`[WA] /api/send-bulk-message  sessionId=${sessionId}  count=${numbers.length}`);
    const sock = requireConnected(sessionId, res);
    if (!sock) return;

    // Respond immediately; progress reported via Socket.io
    res.json({ success: true, message: 'Bulk send started' });

    const total = numbers.length;
    let sent = 0;

    for (const number of numbers) {
        try {
            const jid = toJid(number);
            console.log(`[WA] bulk → ${jid}`);
            await sock.sendMessage(jid, { text: message });
            sent++;
            const progress = Math.round((sent / total) * 100);
            console.log(`[WA] bulk sent ${sent}/${total}`);
            io.emit(`whatsapp-bulk-message-status-${sessionId}`, { status: 'sent', progress, total, sent });
        } catch (e) {
            console.error(`[WA] bulk send error for ${number}: ${e.message}`);
            io.emit(`whatsapp-bulk-message-status-${sessionId}`, { status: 'failed', progress: Math.round((sent / total) * 100), total, sent });
        }
        await sleep(500);
    }

    io.emit(`whatsapp-bulk-message-status-${sessionId}`, { status: 'completed', progress: 100, total, sent });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function toJid(number) {
    // Strip non-digits, ensure @s.whatsapp.net suffix
    const digits = String(number).replace(/\D/g, '');
    return digits.includes('@') ? number : `${digits}@s.whatsapp.net`;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, async () => {
    console.log(`[WA Service] Running on port ${PORT}`);
    await restoreAll(io);
});
