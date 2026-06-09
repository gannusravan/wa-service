import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import pino from 'pino';
import QRCode from 'qrcode';
import axios from 'axios';

const logger = pino({ level: 'silent' });

// Map<userId, { socket, status, phone, qr }>
const sessions = new Map();

const LARAVEL_WEBHOOK = process.env.LARAVEL_WEBHOOK_URL || 'http://localhost:8000/api/whatsapp/webhook';

async function notifyLaravel(userId, status, phone = null) {
    try {
        await axios.post(LARAVEL_WEBHOOK, { sessionId: userId, status, phone }, { timeout: 5000 });
    } catch {
        // Laravel may be down — fail silently
    }
}

export async function startSession(userId, io) {
    if (sessions.has(userId)) {
        const existing = sessions.get(userId);
        // If already connected, nothing to do
        if (existing.status === 'connected') return;
    }

    sessions.set(userId, { socket: null, status: 'connecting', phone: null, qr: null });
    io.emit(`whatsapp-status-${userId}`, { status: 'connecting' });

    const { state, saveCreds } = await useMultiFileAuthState(`auth/${userId}`);
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
            await notifyLaravel(userId, 'connected', phone);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            if (loggedOut) {
                session.status = 'disconnected';
                session.qr = null;
                session.phone = null;
                io.emit(`whatsapp-status-${userId}`, { status: 'disconnected' });
                await notifyLaravel(userId, 'disconnected');
                sessions.delete(userId);
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
    if (!existsSync('auth')) return;
    const entries = await readdir('auth', { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const userId = entry.name;
            console.log(`[WA] Restoring session for user: ${userId}`);
            startSession(userId, io).catch(console.error);
        }
    }
}
