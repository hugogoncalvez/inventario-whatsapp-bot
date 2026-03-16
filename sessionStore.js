const { createClient } = require('@supabase/supabase-js');
const fs = require('fs-extra');
const archiver = require('archiver');
const unzipper = require('unzipper');
const path = require('path');

require('dotenv').config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const BUCKET_NAME = 'whatsapp-session';
const SESSION_FILE = 'session.zip';
const AUTH_PATH = './auth'; // Baileys usa esta carpeta para las credenciales

async function saveSession() {
    console.log('📦 Comprimiendo sesión de Baileys para Supabase...');
    const output = fs.createWriteStream(SESSION_FILE);
    const archive = archiver('zip');

    return new Promise((resolve, reject) => {
        output.on('close', async () => {
            try {
                const fileStream = fs.createReadStream(SESSION_FILE);
                const { error } = await supabase.storage
                    .from(BUCKET_NAME)
                    .upload(SESSION_FILE, fileStream, { 
                        upsert: true,
                        contentType: 'application/zip',
                        duplex: 'half'
                    });

                if (error) throw error;
                console.log('✅ Sesión de Baileys guardada en Supabase');
                await fs.remove(SESSION_FILE);
                resolve();
            } catch (err) {
                reject(err);
            }
        });

        archive.on('error', reject);
        archive.pipe(output);
        
        // Comprimir toda la carpeta auth
        archive.directory(AUTH_PATH, false);
        archive.finalize();
    });
}

async function restoreSession() {
    console.log('🔄 Intentando restaurar sesión de Baileys desde Supabase...');
    try {
        const { data, error } = await supabase.storage
            .from(BUCKET_NAME)
            .download(SESSION_FILE);

        if (error) {
            console.log('ℹ️ No hay sesión previa de Baileys');
            return false;
        }

        const buffer = Buffer.from(await data.arrayBuffer());
        await fs.ensureDir(AUTH_PATH);
        await fs.writeFile(SESSION_FILE, buffer);
        
        await fs.createReadStream(SESSION_FILE)
            .pipe(unzipper.Extract({ path: AUTH_PATH }))
            .promise();

        await fs.remove(SESSION_FILE);
        console.log('✅ Sesión de Baileys restaurada con éxito');
        return true;
    } catch (err) {
        console.error('❌ Error al restaurar sesión de Baileys:', err);
        return false;
    }
}

module.exports = { saveSession, restoreSession };
