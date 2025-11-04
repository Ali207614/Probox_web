require('dotenv').config();
const { Client } = require('minio');

const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';

// === Ichki client (faqat backend <-> MinIO uchun) ===
const internalMinio = new Client({
    endPoint: process.env.MINIO_INTERNAL_HOST || '127.0.0.1',
    port: Number(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true', // sende false
    accessKey,
    secretKey,
});

// === Public client (faqat presigned URL uchun) ===
// Bu client real foydalanuvchi ko‘radigan host/port bilan bo‘lishi shart!
const publicMinio = new Client({
    endPoint: process.env.MINIO_PUBLIC_HOST || process.env.MINIO_END_POINT || 'work-api.probox.uz',
    port: 443,
    useSSL: true,
    accessKey,
    secretKey,
});

// === Bucket mavjudligini tekshirish (ichki client bilan) ===
async function ensureBucket(bucket) {
    try {
        console.log('🔍 Checking MinIO connection...');
        console.log({
            endPoint: process.env.MINIO_INTERNAL_HOST || '127.0.0.1',
            port: process.env.MINIO_PORT,
            useSSL: process.env.MINIO_USE_SSL,
            bucket,
        });

        const exists = await internalMinio.bucketExists(bucket);
        if (exists) {
            console.log(`✅ Bucket '${bucket}' already exists`);
        } else {
            await internalMinio.makeBucket(bucket, 'us-east-1');
            console.log(`🪣 Bucket '${bucket}' created`);
        }
    } catch (err) {
        console.error('❌ MinIO bucket check error:', err.message);
        console.error('⚠️ Full error:', err);
    }
}

// === Presigned URL (public client bilan) ===
async function getPublicUrl(bucket, key, expires = 3600 * 24 * 7) {
    // BU yerda hech qanday replace YUQ!
    const url = await publicMinio.presignedGetObject(bucket, key, expires);
    return url;
}

module.exports = {
    minioClient: internalMinio,
    ensureBucket,
    getPublicUrl,
};
