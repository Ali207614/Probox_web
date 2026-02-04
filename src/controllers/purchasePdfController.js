const PurchasePdf = require('../models/purchase-image-model');
const { GetObjectCommand } = require('@aws-sdk/client-s3');

function assertPdf(file) {
    const mt = String(file?.mimetype || '').toLowerCase();
    const name = String(file?.originalname || '').toLowerCase();

    return (
        mt === 'application/pdf' ||
        mt === 'application/x-pdf' ||
        name.endsWith('.pdf')
    );
}

function safeNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

module.exports = ({ uploadService }) => ({

    uploadPurchasePdf: async (req, res, next) => {
        try {
            const { docEntry, cardCode, docNum } = req.body;
            const file = req.file;

            if (!file) return res.status(400).json({ message: 'PDF yuklanmadi' });
            if (docEntry == null || docEntry === '') {
                return res.status(400).json({ message: 'docEntry majburiy' });
            }

            const docEntryNum = safeNumber(docEntry);
            if (!Number.isFinite(docEntryNum) || docEntryNum <= 0) {
                return res.status(400).json({ message: 'docEntry noto‘g‘ri' });
            }

            if (!assertPdf(file)) {
                return res.status(400).json({ message: 'Faqat PDF qabul qilinadi' });
            }

            const uploaded = await uploadService.uploadFile(
                'purchase-pdfs',
                String(docEntryNum),
                file,
                {
                    allowedMimes: ['application/pdf', 'application/x-pdf'],
                    maxSizeMb: 30,
                }
            );

            const saved = await PurchasePdf.create({
                docEntry: docEntryNum,
                cardCode: cardCode ? String(cardCode).trim() : null,
                docNum: docNum ? String(docNum).trim() : null,
                pdfKey: uploaded.key,
                fileName: uploaded.filename,
                mimeType: uploaded.mimetype,
                size: uploaded.size,
            });

            const pdfUrl = `public/purchases/pdfs/${saved._id}.pdf`;

            return res.json({
                status: true,
                pdf: saved,
                pdfUrl,
            });
        } catch (err) {
            next(err);
        }
    },


    getPurchasePdfsByDocEntry: async (req, res, next) => {
        try {
            const docEntryNum = safeNumber(req.params.docEntry);
            if (!Number.isFinite(docEntryNum) || docEntryNum <= 0) {
                return res.status(400).json({ message: 'docEntry noto‘g‘ri' });
            }

            const items = await PurchasePdf.find({ docEntry: docEntryNum })
                .sort({ createdAt: -1 })
                .lean();

            // ✅ signed emas: oddiy public url qaytaramiz
            const out = items.map((pdf) => ({
                ...pdf,
                pdfUrl: `${process.env.PUBLIC_BASE_URL}/public/purchases/pdfs/${pdf._id}.pdf`,
            }));

            return res.json({
                status: true,
                docEntry: docEntryNum,
                items: out,
            });
        } catch (err) {
            next(err);
        }
    },



    downloadPurchasePdfByDocEntry: async (req, res, next) => {
        try {
            const docEntryNum = Number(req.params.docEntry);
            if (!Number.isFinite(docEntryNum) || docEntryNum <= 0) {
                return res.status(400).json({ message: 'docEntry noto‘g‘ri' });
            }

            const pdf = await PurchasePdf.findOne({ docEntry: docEntryNum })
                .sort({ createdAt: -1 })
                .lean();

            if (!pdf) return res.status(404).json({ message: 'PDF topilmadi' });

            const cmd = new GetObjectCommand({
                Bucket: uploadService.bucket,
                Key: pdf.pdfKey,
            });

            const data = await uploadService.client.send(cmd);

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader(
                'Content-Disposition',
                `inline; filename="${encodeURIComponent(pdf.fileName || `purchase-${docEntryNum}.pdf`)}"`
            );

            data.Body.pipe(res);
        } catch (err) {
            next(err);
        }
    },


    deletePurchasePdf: async (req, res, next) => {
        try {
            const { id } = req.params;

            const pdf = await PurchasePdf.findById(id);
            if (!pdf) return res.status(404).json({ message: 'PDF topilmadi' });

            await uploadService.deleteImages([pdf.pdfKey]);
            await pdf.deleteOne();

            return res.json({ status: true });
        } catch (err) {
            next(err);
        }
    },
});
