require('dotenv').config();
const { Client } = require('minio');

// === Ichki ulanish (backend <-> MinIO) ===
// (har doim lokal port orqali ishlaydi)
const minioClient = new Client({
    endPoint: process.env.MINIO_INTERNAL_HOST || '127.0.0.1',
    port: Number(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

// === Public (frontend uchun presigned URL’larda ishlatiladi) ===
const PUBLIC_BASE_URL =
    process.env.MINIO_PUBLIC_BASE_URL ||
    `https://${process.env.MINIO_END_POINT || 'work-api.probox.uz'}/leads`;

// === Bucket mavjudligini tekshirish ===
async function ensureBucket(bucket) {
    try {
        console.log('🔍 Checking MinIO connection...');
        console.log({
            endPoint: process.env.MINIO_INTERNAL_HOST || '127.0.0.1',
            port: process.env.MINIO_PORT,
            useSSL: process.env.MINIO_USE_SSL,
            bucket,
        });

        const exists = await minioClient.bucketExists(bucket);
        if (exists) {
            console.log(`✅ Bucket '${bucket}' already exists`);
        } else {
            await minioClient.makeBucket(bucket, 'us-east-1');
            console.log(`🪣 Bucket '${bucket}' created`);
        }
    } catch (err) {
        console.error('❌ MinIO bucket check error:', err.message);
        console.error('⚠️ Full error:', err);
    }
}

// === Presigned URL yaratish (frontend uchun) ===
async function getPublicUrl(bucket, key, expires = 3600 * 24 * 7) {
    const url = await minioClient.presignedGetObject(bucket, key, expires);

    // 1️⃣ Ichki hostni public domen bilan almashtiramiz
    let fixedUrl = url
        .replace('127.0.0.1', process.env.MINIO_END_POINT || 'work-api.probox.uz')
        .replace('localhost', process.env.MINIO_END_POINT || 'work-api.probox.uz');

    // 2️⃣ Portni olib tashlaymiz (Nginx 443 orqali proxylaydi)
    fixedUrl = fixedUrl.replace(':9000', '');

    // 3️⃣ Agar /leads/ bo‘limi mavjud bo‘lmasa, qo‘shamiz
    if (!fixedUrl.includes('/leads/')) {
        fixedUrl = fixedUrl.replace(/(https:\/\/[^/]+)/, `$1/leads`);
    }

    return fixedUrl;
}

module.exports = { minioClient, ensureBucket, getPublicUrl };
