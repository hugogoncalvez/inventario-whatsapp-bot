require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const { saveSession, restoreSession } = require('./sessionStore');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8001;

// Configuración del cliente de WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

let isReady = false;

// Eventos de WhatsApp
client.on('qr', (qr) => {
    console.log('--- ESCANEA EL CÓDIGO QR PARA CONECTAR ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ El cliente de WhatsApp está LISTO para enviar mensajes');
    isReady = true;
});

client.on('authenticated', async () => {
    console.log('✅ Autenticación exitosa');
    // Guardar sesión tras autenticación (esperamos a que se generen los archivos)
    setTimeout(async () => {
        try {
            await saveSession();
        } catch (err) {
            console.error('❌ Error al guardar sesión inicial:', err);
        }
    }, 10000);
});

client.on('auth_failure', msg => {
    console.error('❌ Error de autenticación:', msg);
    isReady = false;
});

client.on('disconnected', async (reason) => {
    console.warn('⚠️ Cliente desconectado:', reason);
    isReady = false;
    // Intentar reconectar si no fue una desconexión voluntaria
    client.initialize().catch(err => console.error('Error al re-inicializar:', err));
});

// Evento para ver el ID de los chats (útil para configurar el .env)
client.on('message_create', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    
    // Solo mostramos logs si es un comando especial o si queremos depurar
    if (msg.body === '!id') {
        const chat = await msg.getChat();
        console.log(`--- INFO DE CHAT ---`);
        console.log(`Nombre: ${chat.name}`);
        console.log(`ID: ${chat.id._serialized}`);
        console.log(`--------------------`);
    }
});

// Inicializar cliente (restaurando sesión de Supabase si existe)
(async () => {
    try {
        await restoreSession();
    } catch (err) {
        console.log('ℹ️ No se pudo restaurar la sesión (primera vez)');
    }
    client.initialize();
})();

// --- RUTAS DE LA API ---

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({
        status: isReady ? 'connected' : 'connecting',
        timestamp: new Date()
    });
});

app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isReady) {
        return res.status(503).json({ error: 'El servicio de WhatsApp no está listo' });
    }

    if (!number || !message) {
        return res.status(400).json({ error: 'Número y mensaje son requeridos' });
    }

    try {
        const formattedNumber = number.includes('@') ? number : `${number.replace(/\D/g, '')}@c.us`;
        await client.sendMessage(formattedNumber, message);
        console.log(`🚀 Mensaje enviado a ${formattedNumber}`);
        res.json({ success: true, message: 'Enviado correctamente' });
    } catch (err) {
        console.error('❌ Falló el envío del mensaje:', err);
        res.status(500).json({ error: 'Error al enviar mensaje', details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor de Alertas WhatsApp corriendo en puerto ${PORT}`);
});
