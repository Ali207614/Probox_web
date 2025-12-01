const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { extname } = require('path');

class UploadService {
    constructor() {
        const endpoint = process.env.MINIO_ENDPOINT;
        const port = process.env.MINIO_PORT;
        const useSsl = process.env.MINIO_USE_SSL === 'true';
        const protocol = useSsl ? 'https' : 'http';

        this.bucket = process.env.MINIO_BUCKET;

        this.client = new S3Client({
            region: 'us-east-1',
            endpoint: `${protocol}://${endpoint}:${port}`,
            credentials: {
                accessKeyId: process.env.MINIO_ACCESS_KEY,
                secretAccessKey: process.env.MINIO_SECRET_KEY,
            },
            forcePathStyle: true,
        });
    }

    async deleteImages(keys = []) {
        const validKeys = keys.filter(k => k);

        const promises = validKeys.map(key =>
            this.client.send(
                new DeleteObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                })
            )
        );

        await Promise.all(promises);
    }

    async uploadProfilePicture(userId, file) {
        if (!file) {
            throw new Error('Rasm yuklanmadi');
        }

        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
            throw new Error('Ruxsat etilgan formatlar: jpeg, png, webp');
        }

        return this.uploadImage('profiles', userId, file);
    }

    async uploadImage(folder, entityId, file) {
        if (!file) {
            throw new Error('No file uploaded');
        }

        const allowed = ['image/jpeg', 'image/png', 'image/webp','application/pdf'];
        if (!allowed.includes(file.mimetype)) {
            throw new Error('Ruxsat etilgan formatlar: jpeg, png, webp ,pdf');
        }

        const baseKey = `${folder}/${entityId}/${Date.now()}-${uuidv4().split('-')[0]}`;
        const sizes = { small: 200, medium: 600, large: 1200 };
        const keys = {};

        for (const size in sizes) {
            const width = sizes[size];

            let buffer;
            if (file.mimetype === 'application/pdf') {
                buffer = file.buffer;
            } else {
                buffer = await sharp(file.buffer)
                    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 80 })
                    .toBuffer();
            }


            const key = `${baseKey}-${size}.webp`;

            await this.client.send(
                new PutObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                    Body: buffer,
                    ContentType: 'image/webp',
                    CacheControl: 'public, max-age=31536000, immutable',
                })
            );

            keys[size] = key;
        }

        const urls = await this.generateSignedUrls(keys);
        return { keys, urls };
    }

    async uploadFile(folder, entityId, file, options = {}) {
        if (!file) throw new Error('Fayl yuklanmadi');

        const allowed = options.allowedMimes || [
            'application/pdf',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/zip',
            'application/x-rar-compressed',
        ];

        if (!allowed.includes(file.mimetype)) {
            throw new Error('Ruxsat etilgan formatlar noto‘g‘ri');
        }

        if (options.maxSizeMb && file.size > options.maxSizeMb * 1024 * 1024) {
            throw new Error(`Fayl hajmi ${options.maxSizeMb}MB dan oshmasligi kerak`);
        }

        const ext = extname(file.originalname) || '.bin';
        const key = `${folder}/${entityId}/${Date.now()}-${uuidv4().split('-')[0]}${ext}`;

        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: file.buffer,
                ContentType: file.mimetype,
                Metadata: {
                    originalname: file.originalname,
                },
            })
        );

        const url = await this.getSignedUrl(key, 24 * 3600);

        return {
            key,
            url,
            filename: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
        };
    }

    async generateSignedUrls(keys, expiresIn = 3600) {
        const result = {};
        for (const size in keys) {
            result[size] = await this.getSignedUrl(keys[size], expiresIn);
        }
        return result;
    }

    async getSignedUrl(key, expiresIn = 3600) {
        const cmd = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        });

        return getSignedUrl(this.client, cmd, { expiresIn });
    }
}

module.exports = UploadService;
