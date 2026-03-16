require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { saveSession, restoreSession } = require('./sessionStore');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
let sock;
let isReady = false;

async function connectToWhatsApp() {
    // 1. Intentar restaurar sesión de Supabase
    await restoreSession();

    // 2. Configurar autenticación multi-archivo
    const { state, saveCreds } = await useMultiFileAuthState('auth');

    // 3. Inicializar socket
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Menos ruido en logs
        browser: ['Alert Service', 'Chrome', '1.0.0']
    });

    // Eventos de conexión
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('--- ESCANEA EL CÓDIGO QR PARA CONECTAR ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isReady = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.warn('⚠️ Conexión cerrada. ¿Reconectando?:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅✅✅ WhatsApp Conectado y LISTO ✅✅✅');
            isReady = true;
            
            // Guardar sesión en Supabase una vez conectado con éxito
            try {
                await saveSession();
            } catch (err) {
                console.error('❌ Error guardando sesión en Supabase:', err);
            }
        }
    });

    // Guardar credenciales automáticamente cuando cambien
    sock.ev.on('creds.update', saveCreds);

    // Escuchar mensajes (opcional, igual que antes para ver IDs)
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
            if (text === '!id') {
                const remoteJid = msg.key.remoteJid;
                console.log(`--- INFO DE CHAT ---`);
                console.log(`ID: ${remoteJid}`);
                console.log(`--------------------`);
            }
        }
    });
}

// Iniciar conexión
connectToWhatsApp();

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
        // Formatear número para Baileys (ej: 5493764000000@s.whatsapp.net)
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
    console.log(`🚀 Servidor de Alertas WhatsApp (Socket) corriendo en puerto ${PORT}`);
});
