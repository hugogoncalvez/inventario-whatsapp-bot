require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const { saveSession, restoreSession } = require('./sessionStore');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
console.log(`DEBUG: Iniciando en puerto ${PORT}`);
console.log(`DEBUG: process.env.PORT actual: ${process.env.PORT}`);
console.log(`DEBUG: Memoria total asignada a Node: 256MB`);

// Captura de errores críticos para evitar cierres silenciosos
process.on('uncaughtException', (err) => {
    console.error('❌ CRASH (uncaughtException):', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ CRASH (unhandledRejection):', reason);
});

// Configuración del cliente de WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    // TRUCO MAESTRO: Usar versión web remota para ahorrar ~200MB de RAM
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Crucial para Render
            '--disable-gpu',
            '--disable-extensions', // Ahorra RAM
            '--disable-site-isolation-trials', // Ahorra RAM
            '--no-experiments', // Ahorra RAM
            '--ignore-gpu-blacklist',
            '--js-flags=--max-old-space-size=128' // Limita el motor JS de Chromium
        ]
    }
});

let isReady = false;
let sessionRestored = false;

// Eventos de WhatsApp
client.on('qr', (qr) => {
    console.log('--- ESCANEA EL CÓDIGO QR PARA CONECTAR ---');
    qrcode.generate(qr, { small: true });
    sessionRestored = false;
});

client.on('ready', () => {
    console.log('✅ El cliente de WhatsApp está LISTO');
    isReady = true;
});

client.on('authenticated', async () => {
    console.log('✅ Autenticación exitosa');
    console.log(`DEBUG: sessionRestored = ${sessionRestored}`);
    
    if (!sessionRestored) {
        console.log('⏳ Nueva sesión detectada. Se guardará en 15 segundos...');
        setTimeout(async () => {
            try {
                if (!sessionRestored) {
                    await saveSession();
                    console.log('💾 Nueva sesión guardada exitosamente');
                }
            } catch (err) {
                console.error('❌ Error al guardar nueva sesión:', err);
            }
        }, 15000);
    } else {
        console.log('ℹ️ Sesión previa detectada. Se omite el guardado para ahorrar RAM.');
    }
});

client.on('auth_failure', msg => {
    console.error('❌ Error de autenticación:', msg);
    isReady = false;
});

client.on('disconnected', async (reason) => {
    console.warn('⚠️ Cliente desconectado:', reason);
    isReady = false;
    setTimeout(() => {
        console.log('🔄 Re-inicializando cliente...');
        client.initialize().catch(err => console.error('Error al re-inicializar:', err));
    }, 5000);
});

// Evento para ver el ID de los chats
client.on('message_create', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (msg.body === '!id') {
        const chat = await msg.getChat();
        console.log(`--- INFO DE CHAT ---`);
        console.log(`Nombre: ${chat.name}`);
        console.log(`ID: ${chat.id._serialized}`);
        console.log(`--------------------`);
    }
});

// Inicializar cliente
(async () => {
    try {
        sessionRestored = await restoreSession();
    } catch (err) {
        console.log('ℹ️ No se pudo restaurar la sesión (primera vez)');
    }
    client.initialize();
})();

// --- RUTAS DE LA API ---

app.get('/', (req, res) => {
    res.json({
        service: "WhatsApp Bot",
        status: isReady ? "connected" : "starting",
        sessionRestored: sessionRestored,
        uptime: Math.round(process.uptime()) + "s",
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB"
    });
});

app.get('/health', (req, res) => {
    res.status(isReady ? 200 : 503).json({
        status: isReady ? 'connected' : 'connecting',
        memory: process.memoryUsage(),
        uptime: process.uptime(),
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
