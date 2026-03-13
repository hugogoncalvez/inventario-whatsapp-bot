require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');

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

client.on('authenticated', () => {
    console.log('✅ Autenticación exitosa');
});

client.on('auth_failure', msg => {
    console.error('❌ Error de autenticación:', msg);
    isReady = false;
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ Cliente desconectado:', reason);
    isReady = false;
    client.initialize(); // Intentar reconectar
});

client.on('message_create', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    // Obtener información del chat
    const chat = await msg.getChat();

    console.log('--- DETECCIÓN DE CHAT ---');
    console.log('¿Es Grupo?:', chat.isGroup ? 'SÍ ✅' : 'NO ❌');
    console.log('Nombre del Chat:', chat.name);
    console.log('ID DEL CHAT:', chat.id._serialized); // ESTE ES EL QUE BUSCAMOS
    console.log('Contenido:', msg.body);
    console.log('-------------------------');
})

// Inicializar cliente
client.initialize();

// --- RUTAS DE LA API ---

// Endpoint de salud (para Render)
app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({
        status: isReady ? 'connected' : 'connecting',
        timestamp: new Date()
    });
});

// Endpoint para enviar mensajes desde el Inventario
app.post('/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isReady) {
        return res.status(503).json({ error: 'El servicio de WhatsApp no está listo' });
    }

    if (!number || !message) {
        return res.status(400).json({ error: 'Número y mensaje son requeridos' });
    }

    try {
        // Limpiar el número (quitar +, espacios, etc)
        const formattedNumber = number.includes('@') ? number : `${number.replace(/\D/g, '')}@c.us`;

        await client.sendMessage(formattedNumber, message);
        console.log(`🚀 Mensaje enviado a ${formattedNumber}`);

        res.json({ success: true, message: 'Enviado correctamente' });
    } catch (err) {
        console.error('❌ Falló el envío del mensaje:', err);
        res.status(500).json({ error: 'Error al enviar mensaje', details: err.message });
    }
});

// Servidor Express
app.listen(PORT, () => {
    console.log(`🚀 Servidor de Alertas WhatsApp corriendo en puerto ${PORT}`);
});
