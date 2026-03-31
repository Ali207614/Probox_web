const UploadService = require('../minio');
const multer = require('multer');
const moment = require('moment');
const { GetObjectCommand } = require("@aws-sdk/client-s3");

const uploadService = new UploadService();
const LegalDocument = require('../models/LegalDocument');

class LegalDocumentController {
    uploadLegalDocument = async (req, res, next) => {
        try {
            const { id, doc_name, template_id } = req.body;
            const file = req.file;

            if (!file) {
                return res.status(400).json({ message: 'Fayl yuklanmadi' });
            }

            if (!id) {
                return res.status(400).json({ message: 'id majburiy' });
            }

            if (!template_id || !String(template_id).trim()) {
                return res.status(400).json({ message: 'template_id majburiy' });
            }

            if (!doc_name || !String(doc_name).trim()) {
                return res.status(400).json({ message: 'doc_name majburiy' });
            }

            const slpCode = req.user?.SlpCode ?? req.user?.id;
            const slpName = req.user?.SlpName ?? req.user?.name;

            if (!slpCode || !slpName) {
                return res.status(401).json({ message: 'Foydalanuvchi ma’lumoti topilmadi' });
            }

            const entityId = String(id).trim();

            const uploaded = await uploadService.uploadFile('legal-documents', entityId, file, {
                maxSizeMb: 20,
            });

            const saved = await LegalDocument.create({
                entityId,
                template_id: String(template_id).trim(),
                doc_name: String(doc_name).trim(),
                fileName: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
                key: uploaded.key,
                createdBy: {
                    SlpCode: String(slpCode),
                    SlpName: String(slpName),
                },
            });

            return res.status(201).json({
                status: true,
                message: 'Hujjat muvaffaqiyatli yuklandi',
                document: saved,
            });
        } catch (err) {
            next(err);
        }
    };

    getLegalDocuments = async (req, res, next) => {
        try {
            const { id } = req.params;
            const { doc_name, template_id, page = 1, limit = 10 } = req.query;

            const pageNumber = Math.max(1, Number(page) || 1);
            const limitNumber = Math.max(1, Math.min(100, Number(limit) || 10));
            const skip = (pageNumber - 1) * limitNumber;

            const query = {
                deletedAt: null,
            };

            if (id && String(id).trim()) {
                query.entityId = String(id).trim();
            }

            if (template_id && String(template_id).trim()) {
                query.template_id = String(template_id).trim();
            }

            if (doc_name && String(doc_name).trim()) {
                query.doc_name = String(doc_name).trim();
            }

            const [docs, total] = await Promise.all([
                LegalDocument.find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNumber)
                    .lean(),
                LegalDocument.countDocuments(query),
            ]);

            return res.json({
                status: true,
                page: pageNumber,
                limit: limitNumber,
                total,
                totalPages: Math.ceil(total / limitNumber),
                count: docs.length,
                documents: docs,
            });
        } catch (err) {
            next(err);
        }
    };

    downloadLegalDocument = async (req, res, next) => {
        try {
            const { documentId } = req.params;

            if (!documentId) {
                return res.status(400).json({ message: 'documentId majburiy' });
            }

            const doc = await LegalDocument.findOne({
                entityId: documentId,
                deletedAt: null,
            }).lean();

            if (!doc?.key) {
                return res.status(404).json({ message: 'Hujjat topilmadi' });
            }

            const out = await uploadService.client.send(
                new GetObjectCommand({
                    Bucket: uploadService.bucket,
                    Key: doc.key,
                })
            );

            res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${encodeURIComponent(doc.fileName || 'document')}"`
            );

            if (out?.Body?.pipe) {
                out.Body.on('error', next);
                return out.Body.pipe(res);
            }

            const buf = Buffer.from(await out.Body.transformToByteArray());
            return res.end(buf);
        } catch (err) {
            next(err);
        }
    };

    deleteMultipleLegalDocuments = async (req, res, next) => {
        try {
            const { documentIds } = req.body;

            if (!Array.isArray(documentIds) || !documentIds.length) {
                return res.status(400).json({ message: 'documentIds majburiy array bo‘lishi kerak' });
            }

            const ids = documentIds.map(String);

            const docs = await LegalDocument.find({
                _id: { $in: ids },
                deletedAt: null,
            });

            if (!docs.length) {
                return res.status(404).json({ message: 'Hujjatlar topilmadi' });
            }

            const keys = docs
                .map((item) => item.key)
                .filter(Boolean);

            if (keys.length) {
                await uploadService.deleteImages(keys).catch(() => null);
            }

            await LegalDocument.updateMany(
                {
                    _id: { $in: docs.map((d) => d._id) },
                },
                {
                    $set: { deletedAt: new Date() },
                }
            );

            return res.json({
                status: true,
                message: 'Hujjatlar muvaffaqiyatli o‘chirildi',
                deletedCount: docs.length,
            });
        } catch (err) {
            next(err);
        }
    };

    deleteLegalDocument = async (req, res, next) => {
        try {
            const { documentId } = req.params;

            if (!documentId) {
                return res.status(400).json({ message: 'documentId majburiy' });
            }

            const doc = await LegalDocument.findOne({
                _id: documentId,
                deletedAt: null,
            });

            if (!doc) {
                return res.status(404).json({ message: 'Hujjat topilmadi' });
            }

            if (doc.key) {
                await uploadService.deleteImages([doc.key]).catch(() => null);
            }

            doc.deletedAt = new Date();
            await doc.save();

            return res.json({
                status: true,
                message: 'Hujjat muvaffaqiyatli o‘chirildi',
            });
        } catch (err) {
            next(err);
        }
    };
}

module.exports = new LegalDocumentController();