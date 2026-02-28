'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

const TZ = 'Asia/Tashkent';
const RECALL_STATUSES = ['FollowUp', 'WillVisitStore', 'WillSendPassport'];
const CRON_INTERVAL = '*/5 * * * *';

// ✅ Faqat shu sanadan boshlab yaratilgan leadlar ishlanadi
const BUMP_MIN_DATE = new Date(process.env.BUMP_MIN_DATE || '2025-02-01T00:00:00+05:00');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Lead ning oldingi newTime qiymatini olish (history uchun)
 */
function pickPrevNewTime(lead) {
    return lead.newTime || lead.time || lead.createdAt || null;
}

/**
 * recallDate aniq vaqti kelganmi va hali bump bo'lmaganmi tekshiradi.
 *
 * Mantiq:
 *   1. recallDate bo'lishi shart
 *   2. now >= recallDate  → vaqti kelgan (yoki o'tgan, lekin hali bump bo'lmagan)
 *   3. recallBumpedAt >= recallDate → allaqachon shu recallDate uchun bump qilingan, skip
 *
 * Bu yondashuv:
 *   - recallDate = Feb 26 12:00 bo'lsa, Feb 25 da BUMP QILMAYDI
 *   - recallDate = Feb 24 bo'lsa va bump bo'lmagan bo'lsa, catch-up qiladi
 *   - Bir marta bump bo'lgandan keyin qayta bump qilmaydi
 *   - recallDate yangi sanaga o'zgarsa, yangi sana kelganda yana bump qiladi
 */
function shouldBump(lead, now) {
    if (!lead?.recallDate) return false;

    const recallDate = new Date(lead.recallDate);
    if (Number.isNaN(recallDate.getTime())) return false;

    // recallDate vaqti hali kelmagan
    if (now < recallDate) return false;

    // ✅ Fevraldan oldingi leadlarni o'tkazib yuborish
    if (recallDate < BUMP_MIN_DATE) return false;

    // Bu recallDate uchun allaqachon bump qilingan
    if (lead.recallBumpedAt) {
        const bumpedAt = new Date(lead.recallBumpedAt);
        if (!Number.isNaN(bumpedAt.getTime()) && bumpedAt >= recallDate) {
            return false;
        }
    }

    return true;
}

/**
 * DB query uchun: recallDate <= now VA recallDate >= BUMP_MIN_DATE
 * VA (recallBumpedAt yo'q YOKI recallBumpedAt < recallDate)
 * bo'lgan leadlarni topish.
 *
 * Nota: recallBumpedAt < recallDate sharti — recallDate o'zgarganda qayta bump qilish imkonini beradi.
 */
function buildFilter(now) {
    return {
        status: { $in: RECALL_STATUSES },
        recallDate: { $ne: null, $gte: BUMP_MIN_DATE, $lte: now }, // ✅ fevraldan boshlab
        $or: [
            { recallBumpedAt: { $exists: false } },
            { recallBumpedAt: null },
            // recallBumpedAt < recallDate → recallDate yangilangan, qayta bump kerak
            { $expr: { $lt: ['$recallBumpedAt', '$recallDate'] } },
        ],
    };
}

const SELECT_FIELDS = [
    '_id',
    'n',
    'status',
    'time',
    'newTime',
    'createdAt',
    'updatedAt',
    'recallDate',
    'consideringBumped',
    'consideringBumpedReason',
    'consideringBumpedAt',
    'recallBumpedAt',
].join(' ');

// ─── History ────────────────────────────────────────────────────────────────

function buildChatEvent(lead, now) {
    return {
        leadId: lead._id,
        type: 'event',
        isSystem: true,
        action: 'field_changed',
        createdBy: 0,
        message: `Tizim: recallDate vaqti keldi, lead tepaga ko'tarildi.`,
        changes: [
            { field: 'newTime', from: pickPrevNewTime(lead), to: now },
            { field: 'recallDate', from: lead.recallDate || null, to: lead.recallDate || null },
            { field: 'consideringBumped', from: !!lead.consideringBumped, to: true },
            { field: 'consideringBumpedReason', from: lead.consideringBumpedReason || null, to: 'RecallDate' },
            { field: 'recallBumpedAt', from: lead.recallBumpedAt || null, to: now },
        ],
        createdAt: now,
        updatedAt: now,
    };
}

async function insertHistory(chatEvents) {
    if (!chatEvents.length) return;
    try {
        await LeadChatModel.insertMany(chatEvents, { ordered: false });
    } catch (err) {
        console.error('[CRON:recall-bump] history insert error:', err?.message || err);
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function startLeadRecallBumpCron() {
    cron.schedule(
        CRON_INTERVAL,
        async () => {
            const now = new Date();

            try {
                console.log(`[CRON:recall-bump] started | now=${now.toISOString()}`);

                // 1) DB dan potensial candidatlarni olish
                const filter = buildFilter(now);
                const candidates = await LeadModel.find(filter).select(SELECT_FIELDS).lean();

                if (!candidates.length) {
                    console.log('[CRON:recall-bump] no candidates, done');
                    return;
                }

                // 2) JS da aniq tekshiruv (extra safety)
                const eligible = candidates.filter((lead) => shouldBump(lead, now));

                if (!eligible.length) {
                    console.log(`[CRON:recall-bump] ${candidates.length} candidates, 0 eligible, done`);
                    return;
                }

                const ids = eligible.map((t) => t._id);

                // 3) Atomic update (race condition himoyasi bilan)
                const updateRes = await LeadModel.updateMany(
                    {
                        _id: { $in: ids },
                        status: { $in: RECALL_STATUSES },
                        recallDate: { $ne: null, $gte: BUMP_MIN_DATE, $lte: now }, // ✅ fevraldan boshlab
                        $or: [
                            { recallBumpedAt: { $exists: false } },
                            { recallBumpedAt: null },
                            { $expr: { $lt: ['$recallBumpedAt', '$recallDate'] } },
                        ],
                    },
                    {
                        $set: {
                            newTime: now,
                            consideringBumped: true,
                            consideringBumpedAt: now,
                            consideringBumpedReason: 'RecallDate',
                            recallBumpedAt: now,
                            updatedAt: now,
                        },
                    }
                );

                const modified = updateRes?.modifiedCount ?? updateRes?.nModified ?? 0;

                // 4) History yozish
                const chatEvents = eligible.map((lead) => buildChatEvent(lead, now));
                await insertHistory(chatEvents);

                console.log(
                    `[CRON:recall-bump] done | candidates=${candidates.length} eligible=${eligible.length} modified=${modified}`
                );
            } catch (err) {
                console.error('[CRON:recall-bump] error:', err);
            }
        },
        { timezone: TZ }
    );
}

module.exports = { startLeadRecallBumpCron };