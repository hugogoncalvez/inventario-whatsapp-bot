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

console.log(`[PID:${PID}] 🚀 Iniciando instancia...`);

async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    // Damos 5 segundos de cortesía para que procesos viejos se cierren
    console.log(`[PID:${PID}] ⏳ Esperando estabilidad antes de conectar...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

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

            if (qr) {
                console.log(`[PID:${PID}] ⚠️ QR GENERADO:`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isReady = false;
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.warn(`[PID:${PID}] ⚠️ Conexión cerrada (${statusCode})`);
                
                // Si no es un logout manual, reintentamos
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log(`[PID:${PID}] ✅✅✅ WHATSAPP CONECTADO ✅✅✅`);
                isReady = true;
                isConnecting = false;
                saveSession().catch(e => console.error("Error Supabase:", e));
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        isConnecting = false;
        console.error(`[PID:${PID}] ❌ Error:`, err);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Rutas
app.get('/', (req, res) => {
    res.json({
        service: "WhatsApp Bot",
        status: isReady ? "connected" : "starting/connecting",
        pid: PID,
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB"
    });
});

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'connecting', pid: PID });
});

app.post('/send', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'Not ready' });
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
    // Arrancamos WhatsApp después de que el servidor web esté listo
    (async () => {
        try {
            await fs.ensureDir('./auth');
            await restoreSession();
        } catch (e) {}
        connectToWhatsApp();
    })();
});
