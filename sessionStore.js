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
const AUTH_PATH = './.wwebjs_auth';

async function saveSession() {
    console.log('📦 Comprimiendo sesión para Supabase...');
    const output = fs.createWriteStream(SESSION_FILE);
    const archive = archiver('zip');

    return new Promise((resolve, reject) => {
        output.on('close', async () => {
            try {
                const fileBuffer = await fs.readFile(SESSION_FILE);
                const { error } = await supabase.storage
                    .from(BUCKET_NAME)
                    .upload(SESSION_FILE, fileBuffer, { upsert: true });

                if (error) throw error;
                console.log('✅ Sesión guardada en Supabase');
                await fs.remove(SESSION_FILE);
                resolve();
            } catch (err) {
                reject(err);
            }
        });

        archive.on('error', reject);
        archive.pipe(output);
        
        // Solo incluir archivos esenciales, ignorando la caché pesada
        archive.glob('**/*', {
            cwd: AUTH_PATH,
            ignore: ['**/Cache/**', '**/Code Cache/**', '**/GPUCache/**']
        });

        archive.finalize();
    });
}

async function restoreSession() {
    console.log('🔄 Intentando restaurar sesión desde Supabase...');
    try {
        const { data, error } = await supabase.storage
            .from(BUCKET_NAME)
            .download(SESSION_FILE);

        if (error) {
            console.log('ℹ️ No hay sesión previa o error al descargar');
            return false;
        }

        const buffer = Buffer.from(await data.arrayBuffer());
        await fs.ensureDir(AUTH_PATH);
        
        // Escribir temporalmente el zip para descomprimir
        await fs.writeFile(SESSION_FILE, buffer);
        
        await fs.createReadStream(SESSION_FILE)
            .pipe(unzipper.Extract({ path: AUTH_PATH }))
            .promise();

        await fs.remove(SESSION_FILE);
        console.log('✅ Sesión restaurada con éxito');
        return true;
    } catch (err) {
        console.error('❌ Error al restaurar sesión:', err);
        return false;
    }
}

module.exports = { saveSession, restoreSession };
