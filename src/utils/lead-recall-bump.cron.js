'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

const TZ = 'Asia/Tashkent';
const RECALL_STATUSES = ['FollowUp', 'WillVisitStore', 'WillSendPassport'];

/**
 * newTime old value uchun helper
 */
function pickPrevNewTime(lead) {
    return lead.newTime || lead.time || lead.createdAt || null;
}

/**
 * Timezone bo'yicha YYYY-MM-DD format
 */
function getTzDateKey(date, timeZone = TZ) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return fmt.format(date); // 2026-02-23
}

/**
 * Timezone bo'yicha HH:mm ni olish
 */
function getTzHourMinute(date, timeZone = TZ) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });

    const parts = fmt.formatToParts(date);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';

    return {
        hour: Number(hour),
        minute: Number(minute),
    };
}

/**
 * Asia/Tashkent bo'yicha bugunning boshini UTC Date ko'rinishida qaytaradi.
 * (Mongo query uchun ishlatamiz: recallBumpedAt < todayStartUtc)
 */
function getTodayStartUtcForTz(now = new Date(), timeZone = TZ) {
    // TZ bo'yicha bugungi sana key
    const todayKey = getTzDateKey(now, timeZone); // "YYYY-MM-DD"

    // O'sha sana uchun timezone'dagi 00:00 ni UTCga o'tkazish:
    // Tashkent = UTC+5 (DST yo'q), shuning uchun 00:00 Tashkent = previous day 19:00 UTC
    // Universalroq qilish uchun offsetni runtime'da olamiz.
    const tzNow = new Date(now.toLocaleString('en-US', { timeZone }));
    const utcNow = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = tzNow.getTime() - utcNow.getTime();

    // todayKey ni UTC midnight sifatida yasab, keyin offsetni ayiramiz => TZ midnight UTC
    const utcMidnightOfTodayKey = new Date(`${todayKey}T00:00:00.000Z`);
    return new Date(utcMidnightOfTodayKey.getTime() - offsetMs);
}

/**
 * Daily recurring recall logikasi:
 * - recallDate ichidagi vaqt (HH:mm) har kuni ishlaydi
 * - bugun allaqachon bump bo'lgan bo'lsa, qayta bump qilmaydi
 */
function canBumpForRecall(lead, now) {
    if (!lead?.recallDate) return false;

    const recallDate = new Date(lead.recallDate);
    if (Number.isNaN(recallDate.getTime())) return false;

    // recallDate ichidagi vaqt (TZ bo'yicha)
    const recallHM = getTzHourMinute(recallDate, TZ);
    const nowHM = getTzHourMinute(now, TZ);

    const recallMinutes = recallHM.hour * 60 + recallHM.minute;
    const nowMinutes = nowHM.hour * 60 + nowHM.minute;

    // Bugungi vaqt hali kelmagan bo'lsa bump qilmaymiz
    if (nowMinutes < recallMinutes) return false;

    // Bugun allaqachon bump bo'lgan bo'lsa qayta qilmaymiz
    if (lead.recallBumpedAt) {
        const rb = new Date(lead.recallBumpedAt);
        if (!Number.isNaN(rb.getTime())) {
            const rbDay = getTzDateKey(rb, TZ);
            const nowDay = getTzDateKey(now, TZ);
            if (rbDay === nowDay) return false;
        }
    }

    return true;
}

function startLeadRecallBumpCron() {
    cron.schedule(
        '*/5 * * * *', // ✅ har 5 minutda
        async () => {
            const now = new Date();

            try {
                console.log(`[CRON] lead recall bump started | now=${now.toISOString()}`);

                // ✅ Tashkent bo'yicha bugunning boshi (UTC)
                const todayStartUtc = getTodayStartUtcForTz(now, TZ);

                /**
                 * DB filter (optimized):
                 * - faqat recall statuslar
                 * - recallDate bor
                 * - bugun hali bump bo'lmagan (recallBumpedAt yo'q/null/yoki bugundan oldin)
                 */
                const filter = {
                    status: { $in: RECALL_STATUSES },
                    recallDate: { $ne: null },
                    $or: [
                        { recallBumpedAt: { $exists: false } },
                        { recallBumpedAt: null },
                        { recallBumpedAt: { $lt: todayStartUtc } },
                    ],
                };

                const targets = await LeadModel.find(filter)
                    .select(
                        [
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
                        ].join(' ')
                    )
                    .lean();

                if (!targets.length) {
                    console.log('[CRON] recall bump: no targets');
                    console.log('[CRON] lead recall bump finished');
                    return;
                }

                // ✅ JS ichida faqat HH:mm (va extra safety) tekshiruvi
                const eligible = targets.filter((t) => canBumpForRecall(t, now));

                if (!eligible.length) {
                    console.log('[CRON] recall bump: targets found but none eligible for current time');
                    console.log('[CRON] lead recall bump finished');
                    return;
                }

                const ids = eligible.map((t) => t._id);

                // ✅ updateMany ham bugun hali bump bo'lmagan shart bilan (race condition safety)
                const updateRes = await LeadModel.updateMany(
                    {
                        _id: { $in: ids },
                        status: { $in: RECALL_STATUSES },
                        recallDate: { $ne: null },
                        $or: [
                            { recallBumpedAt: { $exists: false } },
                            { recallBumpedAt: null },
                            { recallBumpedAt: { $lt: todayStartUtc } },
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

                // History faqat real eligible bo'lganlar uchun yoziladi
                const chatEvents = eligible.map((lead) => {
                    const prevNewTime = pickPrevNewTime(lead);

                    return {
                        leadId: lead._id,
                        type: 'event',
                        isSystem: true,
                        action: 'field_changed',
                        createdBy: 0,
                        message: `Tizim: recallDate vaqti keldi, lead tepaga ko'tarildi.`,

                        changes: [
                            { field: 'newTime', from: prevNewTime, to: now },
                            { field: 'recallDate', from: lead.recallDate || null, to: lead.recallDate || null },
                            { field: 'consideringBumped', from: !!lead.consideringBumped, to: true },
                            { field: 'consideringBumpedReason', from: lead.consideringBumpedReason || null, to: 'RecallDate' },
                            { field: 'recallBumpedAt', from: lead.recallBumpedAt || null, to: now },
                        ],

                        createdAt: now,
                        updatedAt: now,
                    };
                });

                try {
                    if (chatEvents.length) {
                        await LeadChatModel.insertMany(chatEvents, { ordered: false });
                    }
                } catch (e) {
                    console.error('[CRON] recall bump: history insert error:', e?.message || e);
                }

                console.log(
                    `[CRON] recall bump done. targets=${targets.length} eligible=${eligible.length} modified=${modified} history=${chatEvents.length}`
                );
                console.log('[CRON] lead recall bump finished');
            } catch (err) {
                console.error('[CRON] lead recall bump error:', err);
            }
        },
        { timezone: TZ }
    );
}

module.exports = { startLeadRecallBumpCron };