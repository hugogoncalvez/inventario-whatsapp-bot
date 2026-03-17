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
let isShuttingDown = false; // Nueva bandera para evitar reconexiones de procesos viejos

console.log(`[PID:${PID}] 🚀 Iniciando instancia...`);

// --- MANEJO DE APAGADO LIMPIO ---
const shutdown = async (signal) => {
    console.log(`[PID:${PID}] 🛑 Recibida señal ${signal}. Cerrando bot...`);
    isShuttingDown = true;
    isReady = false;
    if (sock) {
        sock.ev.removeAllListeners('connection.update');
        sock.logout().catch(() => {});
        sock.end();
    }
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function connectToWhatsApp() {
    if (isConnecting || isShuttingDown) return;
    isConnecting = true;

    // Damos 10 segundos para asegurar que la instancia anterior murió del todo
    console.log(`[PID:${PID}] ⏳ Esperando 10s para estabilización de Render...`);
    await new Promise(resolve => setTimeout(resolve, 10000));

    if (isShuttingDown) return;

    console.log(`[PID:${PID}] 🔄 Conectando a WhatsApp Sockets...`);
    
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

                // SOLO reintentamos si NO nos estamos apagando y NO es un logout manual
                if (!isShuttingDown && statusCode !== DisconnectReason.loggedOut) {
                    console.log(`[PID:${PID}] 🔄 Reintentando en 5s...`);
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log(`[PID:${PID}] ✅✅✅ WHATSAPP CONECTADO ✅✅✅`);
                isReady = true;
                isConnecting = false;
                saveSession().catch(e => {});
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
    if (!isReady || isShuttingDown) return res.status(503).json({ error: 'Bot not ready' });
    const { number, message } = req.body;
    try {
        const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
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
