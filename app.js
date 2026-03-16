require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { saveSession, restoreSession } = require('./sessionStore');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
let sock;
let isReady = false;

async function connectToWhatsApp() {
    // 1. Configurar autenticación multi-archivo (ya restaurada previamente)
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version } = await fetchLatestBaileysVersion();

    // 2. Inicializar socket
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Alert Service', 'Chrome', '1.0.0'],
        keepAliveIntervalMs: 30000, // Mantener socket activo
    });

    // 3. Eventos de conexión
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('--- ESCANEA EL CÓDIGO QR PARA CONECTAR ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.warn(`⚠️ Conexión cerrada (Status ${statusCode}). Reconectando en 5s...`);
            
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 5000); // Reconexión limpia sin re-descargar de Supabase
            }
        } else if (connection === 'open') {
            console.log('✅✅✅ WhatsApp Conectado y LISTO ✅✅✅');
            isReady = true;
            
            // Guardar sesión en Supabase solo una vez al conectar con éxito
            try {
                await saveSession();
            } catch (err) {
                console.error('❌ Error guardando sesión en Supabase:', err);
            }
        }
    });

    // Guardar credenciales automáticamente
    sock.ev.on('creds.update', saveCreds);
}

// --- FLUJO DE INICIO CRÍTICO ---
(async () => {
    console.log('🚀 Iniciando servicio...');
    try {
        // Restauramos sesión desde Supabase UNA SOLA VEZ al arrancar el contenedor
        await restoreSession();
    } catch (err) {
        console.log('ℹ️ No hay sesión previa o error al restaurar');
    }
    
    // Una vez restaurado (o no), iniciamos el socket
    connectToWhatsApp();
})();

// --- RUTAS DE LA API ---

app.get('/', (req, res) => {
    res.json({
        service: "WhatsApp Bot (Baileys Version)",
        status: isReady ? "connected" : "connecting",
        uptime: Math.round(process.uptime()) + "s",
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB"
    });
});

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({
        status: isReady ? 'connected' : 'connecting',
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isReady || !sock) {
        return res.status(503).json({ error: 'El servicio de WhatsApp no está listo' });
    }

    if (!number || !message) {
        return res.status(400).json({ error: 'Número y mensaje son requeridos' });
    }

    try {
        const cleanNumber = number.replace(/\D/g, '');
        const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
        
        await sock.sendMessage(jid, { text: message });
        console.log(`🚀 Mensaje enviado a ${jid}`);
        res.json({ success: true, message: 'Enviado correctamente' });
    } catch (err) {
        console.error('❌ Falló el envío del mensaje:', err);
        res.status(500).json({ error: 'Error al enviar mensaje', details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
