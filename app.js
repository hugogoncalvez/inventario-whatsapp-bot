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

// Render usa el puerto 10000 por defecto. Asegurémonos de que sea ese.
const PORT = process.env.PORT || 10000;
let sock;
let isReady = false;

async function connectToWhatsApp() {
    console.log('🔄 Conectando a WhatsApp...');
    
    // 1. Configurar autenticación (la carpeta 'auth' ya fue restaurada en el inicio)
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version } = await fetchLatestBaileysVersion();

    // 2. Inicializar socket con opciones de estabilidad
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Alert Service', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });

    // 3. Eventos de conexión
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('⚠️ SESIÓN NO ENCONTRADA O EXPIRADA. ESCANEA EL QR:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // Si la sesión fue cerrada manualmente o invalidada (401), borramos la carpeta auth
            if (statusCode === DisconnectReason.loggedOut) {
                console.error('❌ Sesión cerrada por WhatsApp (Logged Out). Borrando credenciales locales...');
                await fs.remove('./auth');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.warn(`⚠️ Conexión perdida (Status ${statusCode}). Reintentando en 5s...`);
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('✅✅✅ WhatsApp Conectado y LISTO ✅✅✅');
            isReady = true;
            
            // Guardar la sesión "buena" en Supabase
            try {
                await saveSession();
            } catch (err) {
                console.error('❌ Error guardando sesión en Supabase:', err);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- INICIO ---
(async () => {
    console.log('🚀 Iniciando servicio...');
    try {
        // Borramos la carpeta auth local antes de restaurar para evitar conflictos
        await fs.remove('./auth');
        const restored = await restoreSession();
        if (restored) {
            console.log('✅ Sesión previa descargada de Supabase');
        }
    } catch (err) {
        console.log('ℹ️ Iniciando sin sesión previa');
    }
    
    connectToWhatsApp();
})();

// --- RUTAS API ---
app.get('/', (req, res) => {
    res.json({
        service: "WhatsApp Bot",
        status: isReady ? "connected" : "starting",
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
        port: PORT
    });
});

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ok' : 'connecting' });
});

app.post('/send', async (req, res) => {
    const { number, message } = req.body;
    if (!isReady) return res.status(503).json({ error: 'WhatsApp no está listo' });

    try {
        const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
