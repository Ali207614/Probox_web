const LeadModel = require('../models/lead-model');
const LeadImage = require('../models/lead-image-model');
const UploadService = require('../minio');
const multer = require('multer');
const moment = require('moment');

const upload = multer({ storage: multer.memoryStorage() });
const uploadService = new UploadService();

class LeadController {

    uploadLeadImage = async (req, res, next) => {
        try {
            const { leadId, cardCode } = req.body;
            const file = req.file;



            if (!file) {
                return res.status(400).json({ message: 'Rasm yuklanmadi' });
            }

            if (!leadId) {
                return res.status(400).json({ message: 'leadId majburiy' });
            }

            const entityId = cardCode ? cardCode : leadId.toString();

            const uploaded = await uploadService.uploadImage(
                "lead-images",
                entityId,
                file
            );

            const saved = await LeadImage.create({
                leadId,
                cardCode: cardCode ?? null,
                keys: uploaded.keys,
                fileName: file.originalname,
                mimeType: file.mimetype,
                size: file.size,
            });

            return res.json({
                status: true,
                image: saved,
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

            const filter = {  };

            if (cardCode) {
                filter.cardCode = cardCode;
            }
            else{
                filter.leadId = leadId;
            }


            const images = await LeadImage.find(filter)
                .sort({ createdAt: -1 })
                .lean();

            const signedImages = [];

            for (const img of images) {
                const keys = img.keys;

                // 3 ta signed URL
                const urls = await uploadService.generateSignedUrls(keys, 3600);

                signedImages.push({
                    ...img,
                    urls, // { small, medium, large }
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

            // 3ta keyni o‘chirish
            await uploadService.deleteImages([
                image.keys.small,
                image.keys.medium,
                image.keys.large,
            ]);

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

}

module.exports = new LeadController();
