require('dotenv').config();
const { Client } = require('minio');

// === Ichki ulanish (backend <-> MinIO) ===
const minioClient = new Client({
    endPoint: process.env.MINIO_INTERNAL_HOST || process.env.MINIO_END_POINT || '127.0.0.1',
    port: Number(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

// === Public (frontend uchun presigned URL) ===
const PUBLIC_BASE_URL =
    process.env.MINIO_PUBLIC_BASE_URL || `https://${process.env.MINIO_END_POINT}/leads`;

// === Bucket mavjudligini tekshirish ===
async function ensureBucket(bucket) {
    try {
        console.log('🔍 Checking MinIO connection...');
        console.log({
            endPoint: process.env.MINIO_INTERNAL_HOST || process.env.MINIO_END_POINT,
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

    // presigned URL ichidagi hostni localhost → public endpoint ga almashtiramiz
    const fixedUrl = url
        .replace('127.0.0.1', process.env.MINIO_END_POINT)
        .replace('localhost', process.env.MINIO_END_POINT)
        .replace(':9000', '/leads');

    return fixedUrl;
}

module.exports = { minioClient, ensureBucket, getPublicUrl };
