const LeadModel = require('../models/lead-model');
const LeadImage = require('../models/lead-image-model');
const UploadService = require('../minio');
const multer = require('multer');
const moment = require('moment');
const { GetObjectCommand } = require("@aws-sdk/client-s3");

const upload = multer({ storage: multer.memoryStorage() });
const uploadService = new UploadService();

class LeadController {
    uploadLeadImage = async (req, res, next) => {
        try {
            const { leadId, cardCode, docNum } = req.body;
            const file = req.file;

            if (!file) return res.status(400).json({ message: 'Fayl yuklanmadi' });
            if (!leadId) return res.status(400).json({ message: 'leadId majburiy' });

            const entityId = cardCode ? cardCode : leadId.toString();

            const uploaded = await uploadService.uploadImage('lead-images', entityId, file);

            const payload = {
                leadId,
                cardCode: cardCode ?? null,
                docNum: docNum ? String(docNum).trim() : null, // ✅ optional
                fileName: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
            };

            if (uploaded.isPdf) {
                payload.isPdf = true;
                payload.pdfKey = uploaded.key;
                payload.keys = {};

            } else {
                payload.isPdf = false;
                payload.keys = uploaded.keys;
            }

            const saved = await LeadImage.create(payload);

            if (saved.isPdf && !saved.docNum) {
                saved.docNum = String(saved._id);
                await saved.save();
            }

            const qrValue = saved.isPdf
                ? `${process.env.PUBLIC_BASE_URL}/public/contracts/${saved.docNum}.pdf`
                : null;

            return res.json({
                status: true,
                image: saved,
                qrValue,
            });
        } catch (err) {
            next(err);
        }
    };

    getLeadImages = async (req, res, next) => {
        try {
            const { leadId } = req.params;
            const { cardCode } = req.query;

            if (!leadId) {
                return res.status(400).json({ message: 'leadId majburiy' });
            }

            const filter = cardCode ? { cardCode } : { leadId };

            const images = await LeadImage.find(filter)
                .sort({ createdAt: -1 })
                .lean();

            const signedImages = [];

            for (const img of images) {

                // === PDF bo‘lsa ===
                if (img.isPdf) {
                    const pdfUrl = await uploadService.getSignedUrl(img.pdfKey, 3600);

                    signedImages.push({
                        ...img,
                        isPdf: true,
                        pdfUrl,        // PDF uchun signed URL
                        urls: null,    // rasm emas
                    });

                    continue;
                }

                const urls = await uploadService.generateSignedUrls(img.keys, 3600);

                signedImages.push({
                    ...img,
                    isPdf: false,
                    urls,   // { small, medium, large }
                    pdfUrl: null,
                });
            }

            return res.json({
                status: true,
                images: signedImages,
            });
        } catch (err) {
            next(err);
        }
    };

    deleteLeadImage = async (req, res, next) => {
        try {
            const { id } = req.params;

            const image = await LeadImage.findById(id);
            if (!image) {
                return res.status(404).json({ message: "Rasm topilmadi" });
            }

            const keysToDelete = [];

            if (image.isPdf) {
                // PDFni o‘chirish
                if (image.pdfKey) keysToDelete.push(image.pdfKey);
            } else {
                // Image bo‘lsa 3ta keyni o‘chirish
                if (image.keys?.small) keysToDelete.push(image.keys.small);
                if (image.keys?.medium) keysToDelete.push(image.keys.medium);
                if (image.keys?.large) keysToDelete.push(image.keys.large);
            }

            await uploadService.deleteImages(keysToDelete);

            await image.deleteOne();

            return res.json({ status: true });
        } catch (err) {
            next(err);
        }
    };

    leadOne = async (req, res, next) => {
        try {
            const { id } = req.params;

            const lead = await LeadModel.findById(id).lean();

            if (!lead) {
                return res.status(404).json({
                    message: 'Lead not found',
                });
            }

            const formatDate = (date, withTime = false) => {
                if (!date) return null;
                return withTime
                    ? moment(date).format('YYYY.MM.DD HH:mm')
                    : moment(date).format('YYYY.MM.DD');
            };

            const data = {
                id: lead._id,
                n: lead.n ?? null,
                status: lead?.status,
                noAnswerCount: lead?.noAnswerCount,
                recallDate:lead?.recallDate,
                newTime:lead.newTime ? moment(lead.newTime).format('YYYY.MM.DD HH:mm') : null,
                address2: lead?.address2 || null,
                seen: lead?.seen,
                clientPhone2: lead?.clientPhone2 || null,
                paymentScore: lead.paymentScore || null,
                totalContracts: lead.totalContracts || null,
                openContracts: lead.openContracts || null,
                totalAmount: lead.totalAmount || null,
                totalPaid: lead.totalPaid || null,
                overdueDebt: lead.overdueDebt || null,
                maxDelay: lead.maxDelay || null,
                avgPaymentDelay: lead.avgPaymentDelay || null,
                cardCode: lead?.cardCode || null,
                acceptedReason: lead?.acceptedReason || null,
                invoiceCreated: lead?.invoiceCreated || null,
                invoiceDocEntry: lead?.invoiceDocEntry || null,
                invoiceDocNum: lead?.invoiceDocNum || null,
                invoiceCreatedAt: lead?.invoiceCreatedAt || null,
                isBlocked: lead?.isBlocked ?? false,
                comment: lead.comment ?? '',
                limit: lead.limit ?? null,
                clientName: lead?.clientName || '',
                clientPhone: lead.clientPhone || '',
                source: lead.source || '',
                time: formatDate(lead.time, true),
                operator: lead.operator || '',
                called: lead.called ?? null,
                callTime: formatDate(lead.callTime, true),
                answered: lead.answered ?? null,
                callCount: lead.callCount ?? 0,
                interested: lead.interested ?? null,
                rejectionReason: lead.rejectionReason || '',
                passportVisit: lead.passportVisit || '',
                jshshir: lead.jshshir || '',
                operator2: lead.operator2 || '',
                source2: lead.source2 || null,
                called2: lead.called2 ?? null,
                answered2: lead.answered2 ?? null,
                callCount2: lead.callCount2 ?? 0,
                meetingDate: formatDate(lead.meetingDate),
                rejectionReason2: lead.rejectionReason2 || '',
                paymentInterest: lead.paymentInterest || '',
                branch: lead.branch || '',
                meetingHappened: lead.meetingHappened ?? null,
                percentage: lead.percentage ?? null,
                meetingConfirmed: lead.meetingConfirmed ?? null,
                meetingConfirmedDate: formatDate(lead.meetingConfirmedDate),
                purchase: lead.purchase ?? null,
                purchaseDate: formatDate(lead.purchaseDate),
                saleType: lead.saleType || '',
                passportId: lead.passportId || '',
                scoring: lead.scoring || null,
                seller: lead.seller || null,
                branch2: lead.branch2 || '',
                clientFullName: lead.clientFullName || '',
                region: lead.region || '',
                district: lead.district || '',
                neighborhood: lead.neighborhood || '',
                street: lead.street || '',
                house: lead.house || '',
                address: lead.address || '',
                birthDate: formatDate(lead.birthDate),
                applicationDate: formatDate(lead.applicationDate),
                age: lead.age ?? null,
                score: lead.score ?? null,
                katm: lead.katm || '',
                katmPayment: lead.katmPayment ?? null,
                paymentHistory: lead.paymentHistory || '',
                mib: lead.mib ?? false,
                mibIrresponsible: lead.mibIrresponsible ?? false,
                aliment: lead.aliment ?? false,
                officialSalary: lead.officialSalary ?? null,
                finalLimit: lead.finalLimit ?? null,
                finalPercentage: lead.finalPercentage ?? null,
                createdAt: formatDate(lead.createdAt, true),
                updatedAt: formatDate(lead.updatedAt, true),
            };

            return res.status(200).json({ data });

        } catch (e) {
            console.error('Error fetching lead details:', e);
            next(e);
        }
    };

    downloadContract = async (req, res, next) => {
        try {
            const { key } = req.params;

            const query = { docNum: key, isPdf: true };

            const doc = await LeadImage.findOne(query).lean();
            if (!doc?.pdfKey) return res.status(404).json({ message: 'Shartnoma topilmadi' });

            const out = await uploadService.client.send(
                new GetObjectCommand({ Bucket: uploadService.bucket, Key: doc.pdfKey })
            );

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="contract-${key}.pdf"`);

            if (out?.Body?.pipe) {
                out.Body.on('error', next);
                return out.Body.pipe(res);
            }

            const buf = Buffer.from(await out.Body.transformToByteArray());
            return res.end(buf);
        } catch (e) {
            next(e);
        }
    };
}

module.exports = new LeadController();
