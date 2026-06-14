import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import pino from 'pino';
import QRCode from 'qrcode';
import axios from 'axios';

const logger = pino({ level: 'silent' });

// Map<userId, { socket, status, phone, qr }>
const sessions = new Map();

// Backend webhook the service POSTs connection/inbound events to. Works with
// any stack (Laravel, MERN/Express, Django, etc.) — it's just an HTTP endpoint.
// WEBHOOK_URL is the generic name; LARAVEL_WEBHOOK_URL is kept for backward compat.
const WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.LARAVEL_WEBHOOK_URL || '';
// Optional shared secret sent as X-Webhook-Secret so the backend can verify the
// request really came from this service.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const AUTH_DIR = process.env.AUTH_DIR || 'auth';

// Delete the stored multi-file auth state for a user so the next session
// start generates a fresh QR instead of reusing invalid credentials.
async function clearAuth(userId) {
    try {
        await rm(`${AUTH_DIR}/${userId}`, { recursive: true, force: true });
    } catch {
        // Folder may not exist — ignore
    }
}

// Notify the backend of a session event. Framework-agnostic JSON payload.
async function notifyWebhook(event, userId, extra = {}) {
    if (!WEBHOOK_URL) return; // No backend configured — skip silently
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (WEBHOOK_SECRET) headers['X-Webhook-Secret'] = WEBHOOK_SECRET;
        await axios.post(
            WEBHOOK_URL,
            { event, sessionId: userId, ...extra },
            { timeout: 5000, headers }
        );
    } catch {
        // Backend may be down — fail silently
    }
}

export async function startSession(userId, io) {
    if (sessions.has(userId)) {
        const existing = sessions.get(userId);
        // Already connected, or a connection attempt is already in flight with a
        // live socket — don't spawn a duplicate (mount() calls /start-session on
        // every page load; a second socket on the same creds triggers a Baileys
        // conflict that can regenerate the QR).
        if (existing.status === 'connected') return;
        if (existing.status === 'connecting' && existing.socket) return;
    }

    sessions.set(userId, { socket: null, status: 'connecting', phone: null, qr: null });
    io.emit(`whatsapp-status-${userId}`, { status: 'connecting' });

    const { state, saveCreds } = await useMultiFileAuthState(`${AUTH_DIR}/${userId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        logger,
        browser: ['WA Service', 'Chrome', '121.0.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
    });

    const session = sessions.get(userId);
    session.socket = sock;

    sock.ev.on('creds.update', saveCreds);

    // Forward inbound messages to the backend webhook so any app can react to
    // replies. Disabled unless FORWARD_INBOUND=true to avoid surprising existing
    // send-only deployments.
    if (process.env.FORWARD_INBOUND === 'true') {
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                const from = msg.key.remoteJid?.split('@')[0] ?? null;
                const text =
                    msg.message?.conversation ??
                    msg.message?.extendedTextMessage?.text ??
                    null;
                await notifyWebhook('message', userId, {
                    from,
                    text,
                    messageId: msg.key.id,
                    timestamp: msg.messageTimestamp,
                });
            }
        });
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const qrDataUrl = await QRCode.toDataURL(qr);
                session.qr = qrDataUrl;
                io.emit(`whatsapp-qr-${userId}`, { qr: qrDataUrl });
            } catch { /* ignore */ }
        }

        if (connection === 'open') {
            session.status = 'connected';
            session.qr = null;
            const phone = sock.user?.id?.split(':')[0] ?? null;
            session.phone = phone;
            io.emit(`whatsapp-status-${userId}`, { status: 'connected', phone });
            await notifyWebhook('connected', userId, { status: 'connected', phone });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            if (loggedOut) {
                // User logged out from their phone — stored credentials are now
                // invalid. Wipe them and start a clean session so a fresh QR is
                // generated for re-login (otherwise it gets stuck "restarting").
                io.emit(`whatsapp-status-${userId}`, { status: 'connecting' });
                await notifyWebhook('disconnected', userId, { status: 'disconnected' });

                try { sock.ev.removeAllListeners('connection.update'); } catch { /* ignore */ }
                sessions.delete(userId);
                await clearAuth(userId);

                // Re-initialise with no creds → emits a new QR automatically
                setTimeout(() => startSession(userId, io).catch(console.error), 1000);
            } else {
                // Reconnect for all other close reasons
                session.status = 'connecting';
                io.emit(`whatsapp-status-${userId}`, { status: 'connecting' });
                setTimeout(() => startSession(userId, io), 3000);
            }
        }
    });
}

export function getStatus(userId) {
    const session = sessions.get(userId);
    if (!session) return { status: 'disconnected' };
    return { status: session.status, phone: session.phone ?? null };
}

export function getQr(userId) {
    const session = sessions.get(userId);
    return session?.qr ?? null;
}

export function getSocket(userId) {
    return sessions.get(userId)?.socket ?? null;
}

export async function restoreAll(io) {
    if (!existsSync(AUTH_DIR)) return;
    const entries = await readdir(AUTH_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const userId = entry.name;
            console.log(`[WA] Restoring session for user: ${userId}`);
            startSession(userId, io).catch(console.error);
        }
    }
}
