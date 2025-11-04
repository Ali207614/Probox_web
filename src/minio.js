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

async function getPublicUrl(bucket, key, expires = 3600 * 24 * 7) {
    const url = await minioClient.presignedGetObject(bucket, key, expires);
    let fixedUrl = url
        .replace('127.0.0.1', process.env.MINIO_END_POINT)
        .replace('localhost', process.env.MINIO_END_POINT)
        .replace(':9000', '');
    return fixedUrl;
}


module.exports = { minioClient, ensureBucket, getPublicUrl };
