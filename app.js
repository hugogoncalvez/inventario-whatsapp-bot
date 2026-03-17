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

// Forzamos el puerto 10000 si no hay uno definido (ideal para Render)
const PORT = process.env.PORT || 10000;
let sock;
let isReady = false;
let isConnecting = false;

// --- CAPTURA DE ERRORES GLOBALES PARA EVITAR CRASHES ---
process.on('uncaughtException', (err) => {
    console.error('❌ EXCEPCIÓN NO CAPTURADA:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ PROMESA NO MANEJADA:', reason);
});

async function connectToWhatsApp() {
    if (isConnecting) return; // Evitar múltiples intentos simultáneos
    isConnecting = true;

    console.log('🔄 Iniciando socket de WhatsApp...');
    
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
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('⚠️ SESIÓN NO ENCONTRADA. ESCANEA EL QR:');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isReady = false;
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.warn(`⚠️ Conexión cerrada. Motivo: ${statusCode}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.error('❌ Sesión invalidada. Borrando datos...');
                    await fs.remove('./auth');
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    // Reintentar en otros casos (red, timeout, etc)
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log('✅✅✅ WhatsApp Conectado y LISTO ✅✅✅');
                isReady = true;
                isConnecting = false;
                
                // Guardar sesión en Supabase (con manejo de error local)
                saveSession().catch(err => console.error('❌ Error al subir a Supabase:', err));
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        isConnecting = false;
        console.error('❌ Error crítico en connectToWhatsApp:', err);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// --- INICIO ---
(async () => {
    console.log('🚀 Iniciando servicio...');
    try {
        // Asegurar que la carpeta auth existe y está limpia si es necesario
        if (!fs.existsSync('./auth')) await fs.ensureDir('./auth');
        
        const restored = await restoreSession();
        if (restored) console.log('✅ Sesión previa descargada');
    } catch (err) {
        console.log('ℹ️ Iniciando sin sesión previa');
    }
    
    connectToWhatsApp();
})();

// --- RUTAS ---
app.get('/', (req, res) => {
    res.json({
        status: isReady ? "connected" : "connecting",
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB"
    });
});

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'connecting' });
});

app.post('/send', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'WhatsApp no está listo' });
    
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error enviando:', err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
