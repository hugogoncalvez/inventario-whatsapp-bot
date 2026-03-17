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

// Puerto estándar de Render
const PORT = process.env.PORT || 10000;
const PID = process.pid; // ID del proceso para detectar duplicados

let sock;
let isReady = false;
let isConnecting = false;

console.log(`[PID:${PID}] 🚀 Iniciando instancia del servicio...`);

async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    console.log(`[PID:${PID}] 🔄 Intentando conectar a WhatsApp Sockets...`);
    
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
                console.log(`[PID:${PID}] ⚠️ QR GENERADO. Escanea para conectar.`);
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isReady = false;
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.warn(`[PID:${PID}] ⚠️ Conexión cerrada (Status: ${statusCode})`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.error('❌ Sesión cerrada permanentemente. Borrando auth...');
                    await fs.remove('./auth');
                }
                
                // Reintento automático
                setTimeout(connectToWhatsApp, 5000);
            } else if (connection === 'open') {
                console.log(`[PID:${PID}] ✅✅✅ WHATSAPP CONECTADO Y LISTO ✅✅✅`);
                isReady = true;
                isConnecting = false;
                
                saveSession().catch(err => console.error('❌ Error Supabase:', err));
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        isConnecting = false;
        console.error(`[PID:${PID}] ❌ Error en el socket:`, err);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Inicialización
(async () => {
    try {
        await fs.ensureDir('./auth');
        const restored = await restoreSession();
        if (restored) console.log(`[PID:${PID}] ✅ Sesión restaurada de la nube`);
        
        connectToWhatsApp();
    } catch (err) {
        console.error('Error en arranque:', err);
        connectToWhatsApp();
    }
})();

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'connecting', pid: PID });
});

app.post('/send', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'WhatsApp no listo' });
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
    console.log(`[PID:${PID}] 🚀 Servidor web en puerto ${PORT}`);
});
