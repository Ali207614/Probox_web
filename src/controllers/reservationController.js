const mongoose = require('mongoose');
const ReservationModel = require('../models/reservation-model');
const LeadModel = require('../models/lead-model');
const { addWorkingHours } = require('../utils/business-days');
const { writeLeadEvent } = require('../utils/lead-chat-events.util');

const RESERVATION_WORKING_HOURS = Number(process.env.RESERVATION_WORKING_HOURS) || 6;

const CREATE_ROLES = new Set(['Seller', 'SellerM', 'OperatorM', 'Operator1', 'Operator2', 'Manager', 'CEO']);
const ADMIN_RELEASE_ROLES = new Set(['SellerM', 'Manager', 'CEO']);

function pickUser(req) {
    const u = req.user || {};
    return {
        id: u.SlpCode ?? u.id ?? null,
        name: u.SlpName ?? u.U_name ?? null,
        role: u.U_role ?? null,
    };
}

function canReleaseReservation(user, reservation) {
    if (ADMIN_RELEASE_ROLES.has(user.role)) return true;
    return reservation.reservedBy != null && Number(reservation.reservedBy) === Number(user.id);
}

async function releaseReservationsForLead({ leadId, reason, actor = null }) {
    if (!leadId) return { modifiedCount: 0 };

    const activeBefore = await ReservationModel.find(
        { leadId, status: 'active' },
        { itemCode: 1, itemName: 1, imei: 1 }
    ).lean();

    const update = {
        status: reason === 'purchased' ? 'consumed' : 'released',
        releaseReason: reason,
        releasedAt: new Date(),
    };

    if (actor) {
        update.releasedBy = actor.id ?? null;
        update.releasedByName = actor.name ?? null;
        update.releasedByRole = actor.role ?? null;
    }

    const result = await ReservationModel.updateMany(
        { leadId, status: 'active' },
        { $set: update }
    );

    for (const r of activeBefore) {
        const label = r.itemName ? `${r.itemName} (IMEI: ${r.imei})` : `IMEI: ${r.imei}`;
        try {
            await writeLeadEvent({
                leadId,
                reqUser: actor
                    ? { SlpCode: actor.id, U_name: actor.name, U_role: actor.role }
                    : null,
                isSystem: !actor,
                type: 'event',
                action: 'reservation_released',
                message: `Bron olib tashlandi: ${label} — sabab: ${reason}`,
            });
        } catch (err) {
            console.error('❌ reservation_released chat event xatolik:', err.message);
        }
    }

    return { modifiedCount: result.modifiedCount || 0 };
}

class ReservationController {
    createReservation = async (req, res, next) => {
        try {
            const user = pickUser(req);

            if (!CREATE_ROLES.has(user.role)) {
                return res.status(403).json({
                    message: `Role ${user.role} bron yarata olmaydi`,
                });
            }

            const { leadId, itemCode, imei, itemName, warehouseCode, quantity } = req.body || {};

            if (!leadId || !mongoose.isValidObjectId(leadId)) {
                return res.status(400).json({ message: 'leadId noto\'g\'ri yoki yo\'q' });
            }
            if (!itemCode || typeof itemCode !== 'string') {
                return res.status(400).json({ message: 'itemCode majburiy' });
            }
            if (!imei || typeof imei !== 'string' || !imei.trim()) {
                return res.status(400).json({
                    message: 'IMEI majburiy. IMEIsiz bron qilish mumkin emas.',
                    location: 'imei_required',
                });
            }

            const imeiTrim = imei.trim();

            const lead = await LeadModel.findById(leadId).lean();
            if (!lead) {
                return res.status(404).json({ message: 'Lead topilmadi' });
            }

            const BLOCK_STATUSES = new Set(['Purchased', 'NoPurchase', 'Closed', 'Blocked']);
            if (BLOCK_STATUSES.has(lead.status)) {
                return res.status(400).json({
                    message: `Lead statusi ${lead.status} — bron qilib bo'lmaydi`,
                });
            }
            if (lead.isBlocked) {
                return res.status(400).json({ message: 'Lead bloklangan — bron qilib bo\'lmaydi' });
            }

            const existing = await ReservationModel.findOne({ imei: imeiTrim, status: 'active' }).lean();
            if (existing) {
                return res.status(409).json({
                    message: 'Bu IMEI allaqachon boshqa lead uchun band qilingan',
                    imei: imeiTrim,
                    reservedLeadId: existing.leadId,
                });
            }

            const now = new Date();
            const expiresAt = addWorkingHours(now, RESERVATION_WORKING_HOURS);

            const reservation = await ReservationModel.create({
                leadId,
                itemCode: itemCode.trim(),
                itemName: itemName || null,
                imei: imeiTrim,
                warehouseCode: warehouseCode || null,
                quantity: quantity && Number(quantity) > 0 ? Number(quantity) : 1,
                reservedBy: user.id,
                reservedByName: user.name,
                reservedByRole: user.role,
                reservedAt: now,
                expiresAt,
                status: 'active',
            });

            try {
                const label = reservation.itemName
                    ? `${reservation.itemName} (IMEI: ${reservation.imei})`
                    : `IMEI: ${reservation.imei}`;
                await writeLeadEvent({
                    leadId,
                    reqUser: req.user,
                    type: 'event',
                    action: 'reservation_created',
                    message: `Bron qo'shildi: ${label}`,
                });
            } catch (err) {
                console.error('❌ reservation_created chat event xatolik:', err.message);
            }

            return res.status(201).json({ data: reservation });
        } catch (err) {
            if (err && err.code === 11000) {
                return res.status(409).json({
                    message: 'Bu IMEI allaqachon band qilingan (unique)',
                });
            }
            return next(err);
        }
    };

    deleteReservation = async (req, res, next) => {
        try {
            const user = pickUser(req);
            const { id } = req.params;

            if (!mongoose.isValidObjectId(id)) {
                return res.status(400).json({ message: 'id noto\'g\'ri' });
            }

            const reservation = await ReservationModel.findById(id);
            if (!reservation) {
                return res.status(404).json({ message: 'Reservation topilmadi' });
            }

            if (reservation.status !== 'active') {
                return res.status(400).json({
                    message: `Bron allaqachon ${reservation.status} holatida`,
                });
            }

            if (!canReleaseReservation(user, reservation)) {
                return res.status(403).json({
                    message: 'Sizga bu bronni yechishga ruxsat yo\'q. Faqat yaratgan foydalanuvchi yoki SellerM/Manager/CEO',
                });
            }

            reservation.status = 'released';
            reservation.releaseReason = 'manual';
            reservation.releasedAt = new Date();
            reservation.releasedBy = user.id;
            reservation.releasedByName = user.name;
            reservation.releasedByRole = user.role;
            await reservation.save();

            try {
                const label = reservation.itemName
                    ? `${reservation.itemName} (IMEI: ${reservation.imei})`
                    : `IMEI: ${reservation.imei}`;
                await writeLeadEvent({
                    leadId: reservation.leadId,
                    reqUser: req.user,
                    type: 'event',
                    action: 'reservation_released',
                    message: `Bron olib tashlandi: ${label} — sabab: manual`,
                });
            } catch (err) {
                console.error('❌ reservation_released chat event xatolik:', err.message);
            }

            return res.status(200).json({ data: reservation });
        } catch (err) {
            return next(err);
        }
    };

    getReservationsByLead = async (req, res, next) => {
        try {
            const { leadId } = req.params;
            if (!mongoose.isValidObjectId(leadId)) {
                return res.status(400).json({ message: 'leadId noto\'g\'ri' });
            }

            const statusQ = req.query.status;
            const filter = { leadId };
            if (statusQ === 'active' || statusQ === 'released' || statusQ === 'expired' || statusQ === 'consumed') {
                filter.status = statusQ;
            } else if (statusQ !== 'all') {
                filter.status = 'active';
            }

            const data = await ReservationModel.find(filter).sort({ created_at: -1 }).lean();
            return res.status(200).json({ data });
        } catch (err) {
            return next(err);
        }
    };

    listReservations = async (req, res, next) => {
        try {
            const page = Math.max(parseInt(req.query.page) || 1, 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
            const skip = (page - 1) * limit;

            const {
                status = 'active',
                imei,
                itemCode,
                reservedBy,
                branch,
                search,
                leadId,
            } = req.query;

            const match = {};
            if (['active', 'released', 'expired', 'consumed'].includes(status)) {
                match.status = status;
            }
            if (imei) match.imei = String(imei).trim();
            if (itemCode) match.itemCode = String(itemCode).trim();
            if (reservedBy) match.reservedBy = Number(reservedBy);
            if (leadId) {
                if (!mongoose.isValidObjectId(leadId)) {
                    return res.status(400).json({ message: 'leadId noto\'g\'ri' });
                }
                match.leadId = new mongoose.Types.ObjectId(leadId);
            }

            const pipeline = [
                { $match: match },
                { $sort: { created_at: -1 } },
                {
                    $lookup: {
                        from: 'leads',
                        localField: 'leadId',
                        foreignField: '_id',
                        as: 'lead',
                    },
                },
                { $unwind: { path: '$lead', preserveNullAndEmptyArrays: true } },
            ];

            if (branch) {
                pipeline.push({ $match: { 'lead.branch': branch } });
            }

            if (search) {
                const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                pipeline.push({
                    $match: {
                        $or: [
                            { 'lead.clientName': { $regex: safe, $options: 'i' } },
                            { 'lead.clientPhone': { $regex: safe } },
                            { 'lead.clientPhone2': { $regex: safe } },
                            { imei: { $regex: safe } },
                            { itemName: { $regex: safe, $options: 'i' } },
                            { itemCode: { $regex: safe, $options: 'i' } },
                        ],
                    },
                });
            }

            pipeline.push({
                $facet: {
                    data: [
                        { $skip: skip },
                        { $limit: limit },
                        {
                            $project: {
                                _id: 1,
                                leadId: 1,
                                itemCode: 1,
                                itemName: 1,
                                imei: 1,
                                warehouseCode: 1,
                                quantity: 1,
                                status: 1,
                                reservedBy: 1,
                                reservedByName: 1,
                                reservedByRole: 1,
                                reservedAt: 1,
                                expiresAt: 1,
                                releasedAt: 1,
                                releaseReason: 1,
                                created_at: 1,
                                clientName: '$lead.clientName',
                                clientPhone: '$lead.clientPhone',
                                clientPhone2: '$lead.clientPhone2',
                                leadStatus: '$lead.status',
                                branch: '$lead.branch',
                            },
                        },
                    ],
                    total: [{ $count: 'value' }],
                },
            });

            const [result] = await ReservationModel.aggregate(pipeline);
            const total = result?.total?.[0]?.value || 0;
            const data = result?.data || [];

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data,
            });
        } catch (err) {
            return next(err);
        }
    };
}

const controllerInstance = new ReservationController();
controllerInstance.releaseReservationsForLead = releaseReservationsForLead;

module.exports = controllerInstance;
module.exports.releaseReservationsForLead = releaseReservationsForLead;
