const UploadService = require('../minio');
const multer = require('multer');
const moment = require('moment');
const { GetObjectCommand } = require("@aws-sdk/client-s3");

const uploadService = new UploadService();
const LegalDocument = require('../models/LegalDocument');

class LegalDocumentController {
    uploadLegalDocument = async (req, res, next) => {
        try {
            const { id, doc_name } = req.body;
            const file = req.file;

            if (!file) {
                return res.status(400).json({ message: 'Fayl yuklanmadi' });
            }

            if (!id) {
                return res.status(400).json({ message: 'id majburiy' });
            }

            if (!doc_name || !String(doc_name).trim()) {
                return res.status(400).json({ message: 'doc_name majburiy' });
            }

            const uploaded = await uploadService.uploadFile('legal-documents', String(id).trim(), file, {
                maxSizeMb: 20,
            });

            const saved = await LegalDocument.create({
                entityId: String(id).trim(),
                doc_name: String(doc_name).trim(),
                fileName: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
                key: uploaded.key,
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
            const { doc_name } = req.query;

            if (!id) {
                return res.status(400).json({ message: 'id majburiy' });
            }

            const query = {
                entityId: String(id).trim(),
                deletedAt: null,
            };

            if (doc_name && String(doc_name).trim()) {
                query.doc_name = String(doc_name).trim();
            }

            const docs = await LegalDocument.find(query)
                .sort({ createdAt: -1 })
                .lean();

            return res.json({
                status: true,
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
                _id: documentId,
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