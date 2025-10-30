require('dotenv').config();
const { Client } = require('minio');

const minioClient = new Client({
    endPoint: process.env.MINIO_END_POINT || '127.0.0.1',
    port: Number(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

async function ensureBucket(bucket) {
    try {
        console.log('🔍 Checking MinIO connection...');
        console.log({
            endPoint: process.env.MINIO_END_POINT,
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

module.exports = { minioClient, ensureBucket };
