require('dotenv').config();
const { Client } = require('minio');

const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';

// Ichki MinIO client (faqat 127.0.0.1:9000 bilan ishlaydi)
const minioClient = new Client({
    endPoint: process.env.MINIO_INTERNAL_HOST || '127.0.0.1',
    port: Number(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey,
    secretKey,
});

// Bucket mavjudligini tekshirish
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

// presigned URL – faqat ichki client bilan, keyin faqat BASE ni almashtiramiz
async function getPublicUrl(bucket, key, expires = 3600 * 24 * 7) {
    const url = await minioClient.presignedGetObject(bucket, key, expires);

    const internalBase = `http://${process.env.MINIO_INTERNAL_HOST || '127.0.0.1'}:${process.env.MINIO_PORT || 9000}`;
    const externalBase = `https://${process.env.MINIO_PUBLIC_HOST || process.env.MINIO_END_POINT}/leads`;

    // Faqat host+port qismni almashtiramiz, path + query'ga tegmaymiz
    const fixed = url.replace(internalBase, externalBase);
    return fixed;
}

module.exports = { minioClient, ensureBucket, getPublicUrl };
