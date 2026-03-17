require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const { saveSession, restoreSession } = require('./sessionStore');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PID = process.pid;

let sock;
let isReady = false;
let isConnecting = false;
let isShuttingDown = false;

console.log(`[PID:${PID}] 🚀 Iniciando instancia...`);

// --- APAGADO LIMPIO (SIN DESLOGUEAR) ---
const shutdown = async (signal) => {
    if (isShuttingDown) return;
    console.log(`[PID:${PID}] 🛑 Señal ${signal}: Cerrando conexión...`);
    isShuttingDown = true;
    isReady = false;
    if (sock) {
        sock.ev.removeAllListeners('connection.update');
        sock.end(); // IMPORTANTE: end() mantiene la sesión, logout() la borra.
    }
    setTimeout(() => process.exit(0), 1000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function connectToWhatsApp() {
    if (isConnecting || isShuttingDown) return;
    isConnecting = true;

    console.log(`[PID:${PID}] ⏳ Esperando 10s para estabilización...`);
    await new Promise(resolve => setTimeout(resolve, 10000));

    if (isShuttingDown) return;
    console.log(`[PID:${PID}] 🔄 Conectando a WhatsApp...`);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Alert Service', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            shouldIgnoreJid: (jid) => jid.includes('broadcast'), // Evitar procesar estados/newsletters para ahorrar RAM
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !isShuttingDown) {
                console.log(`[PID:${PID}] ⚠️ QR GENERADO:`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isReady = false;
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.warn(`[PID:${PID}] ⚠️ Conexión cerrada (${statusCode})`);

                if (isShuttingDown) return;

                if (statusCode === DisconnectReason.loggedOut) {
                    console.error('❌ Sesión desvinculada. Borrando auth...');
                    await fs.remove('./auth');
                    setTimeout(connectToWhatsApp, 5000);
                } else if (statusCode === 440) {
                    console.warn('⚠️ Conflicto de sesión (440). Esperando 20s para reintentar...');
                    setTimeout(connectToWhatsApp, 20000);
                } else {
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log(`[PID:${PID}] ✅✅✅ WHATSAPP CONECTADO ✅✅✅`);
                isReady = true;
                isConnecting = false;
                saveSession().catch(() => {});
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        isConnecting = false;
        if (!isShuttingDown) {
            console.error(`[PID:${PID}] ❌ Error:`, err);
            setTimeout(connectToWhatsApp, 10000);
        }
    }
}

app.get('/', (req, res) => {
    res.json({
        service: "WhatsApp Bot",
        status: isReady ? "connected" : "connecting",
        pid: PID,
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB"
    });
});

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'connecting' });
});

app.post('/send', async (req, res) => {
    if (!isReady || isShuttingDown) return res.status(503).json({ error: 'Bot no listo' });
    const { number, message } = req.body;
    
    try {
        let jid;
        // Si ya incluye el dominio (ej: @g.us o @s.whatsapp.net), lo usamos tal cual
        if (number.includes('@')) {
            jid = number.trim();
        } else {
            // Si es solo un número, lo limpiamos y añadimos el dominio de usuario
            jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        }

        console.log(`[PID:${PID}] 📤 Enviando mensaje a: ${jid}`);
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, to: jid });
    } catch (err) {
        console.error(`[PID:${PID}] ❌ Error al enviar:`, err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`[PID:${PID}] 🚀 Servidor en puerto ${PORT}`);
    (async () => {
        try {
            await fs.ensureDir('./auth');
            await restoreSession();
        } catch (e) {}
        connectToWhatsApp();
    })();
});
