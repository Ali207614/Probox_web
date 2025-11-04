const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const mime = require('mime-types');
const crypto = require('crypto');
const { minioClient, getPublicUrl } = require('../minio');
const LeadImageModel = require('../models/lead-image-model');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const BUCKET = process.env.MINIO_BUCKET;

// === Helper: Faylni MinIO ga yuklash ===
async function uploadToMinio(cardCode, file) {
    const ext = mime.extension(file.mimetype) || 'jpg';
    const fileName = `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
    const key = `leads/${cardCode}/${fileName}`;

    // sharp bilan siqish (800px maksimal)
    const buffer = await sharp(file.buffer)
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

    // MinIO'ga joylash
    await minioClient.putObject(BUCKET, key, buffer, {
        'Content-Type': file.mimetype,
        'Cache-Control': 'public, max-age=31536000',
    });

    // presigned URL (getPublicUrl bilan)
    let url = await getPublicUrl(BUCKET, key);

    // ⚙️ Agar public host ENV orqali berilgan bo‘lsa, almashtiramiz
    const publicHost = process.env.MINIO_PUBLIC_HOST || process.env.MINIO_END_POINT;
    if (publicHost) {
        url = url
            .replace('127.0.0.1', publicHost)
            .replace('localhost', publicHost)
            .replace(':9000', ''); // ⚠️ portni olib tashlash zarur
    }

    // Ortiqcha “/leads/leads/” holatini tozalaymiz (xavfsiz usul)
    url = url.replace('/leads/leads/', '/leads/');

    return {
        key,
        url,
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        cardCode,
    };
}

// === POST /api/lead-images/:cardCode ===
// Bir nechta rasm yuklash
router.post('/:cardCode', upload.array('images', 10), async (req, res) => {
    try {
        const { cardCode } = req.params;
        const files = req.files;

        if (!cardCode)
            return res.status(400).json({ message: 'cardCode is required' });
        if (!files?.length)
            return res.status(400).json({ message: 'images are required' });

        const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
        const invalid = files.filter((f) => !allowed.includes(f.mimetype));
        if (invalid.length > 0)
            return res.status(400).json({ message: 'Only PNG, JPG, JPEG allowed' });

        const uploadedImages = [];
        for (const file of files) {
            const uploaded = await uploadToMinio(cardCode, file);
            uploadedImages.push(uploaded);
        }

        await LeadImageModel.insertMany(uploadedImages);

        res.json({
            message: `${uploadedImages.length} images uploaded successfully`,
            cardCode,
            images: uploadedImages,
        });
    } catch (err) {
        console.error('❌ Upload error:', err);
        res.status(500).json({ message: 'Internal error', error: err.message });
    }
});

// === GET /api/lead-images/:cardCode ===
// CardCode bo‘yicha rasm ro‘yxatini olish
router.get('/:cardCode', async (req, res) => {
    try {
        const { cardCode } = req.params;
        const images = await LeadImageModel.find({ cardCode }).sort({ createdAt: -1 });
        res.json(images);
    } catch (err) {
        console.error('❌ Fetch error:', err);
        res.status(500).json({ message: 'Internal error', error: err.message });
    }
});

// === DELETE /api/lead-images/:id ===
// Rasmni MinIO dan va DB dan o‘chirish
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const image = await LeadImageModel.findById(id);
        if (!image) return res.status(404).json({ message: 'Image not found' });

        await minioClient.removeObject(BUCKET, image.key);
        await LeadImageModel.deleteOne({ _id: id });

        res.json({ message: 'Image deleted successfully', id });
    } catch (err) {
        console.error('❌ Delete error:', err);
        res.status(500).json({ message: 'Internal error', error: err.message });
    }
});

module.exports = router;
