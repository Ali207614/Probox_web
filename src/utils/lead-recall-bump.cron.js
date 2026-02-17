'use strict';

/**
 * File: lead-recall-bump.cron.js
 *
 * Purpose:
 * - FollowUp / WillVisitStore / WillSendPassport statuslarida recallDate vaqti kelganda leadni tepaga chiqarish (newTime=now).
 * - Cron har soatda ishlaydi va recallDate shu soat intervalida bo'lgan leadlarni bump qiladi.
 * - 2 marta bump bo'lishini oldini olish uchun:
 *   - recallBumpedAt (ideal) + fallback newTime < startHour shartlari ishlatiladi.
 */

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

const TZ = 'Asia/Tashkent';

const RECALL_STATUSES = ['FollowUp', 'WillVisitStore', 'WillSendPassport'];

/**
 * Helpers
 */
function startOfHour(d = new Date()) {
    const x = new Date(d);
    x.setMinutes(0, 0, 0);
    return x;
}

function addHours(d, hours) {
    return new Date(d.getTime() + hours * 60 * 60 * 1000);
}

function pickPrevNewTime(lead) {
    return lead.newTime || lead.time || lead.createdAt || null;
}

function canBumpOncePerHour(lead, hourStart) {
    // ✅ newTime shu soatda bo'lsa qayta bump qilmaymiz
    const nt = lead.newTime ? new Date(lead.newTime) : null;
    if (nt && nt >= hourStart) return false;

    // ✅ recallBumpedAt shu soatda bo'lsa qayta bump qilmaymiz
    const rb = lead.recallBumpedAt ? new Date(lead.recallBumpedAt) : null;
    if (rb && rb >= hourStart) return false;

    return true;
}

/**
 * Cron
 */
function startLeadRecallBumpCron() {
    cron.schedule(
        '0 * * * *', // ✅ har soatda 1 marta (soat boshida)
        async () => {
            const now = new Date();
            const hourStart = startOfHour(now);
            const hourEnd = addHours(hourStart, 1);

            try {
                console.log(
                    `[CRON] lead recall bump started | window=${hourStart.toISOString()}..${hourEnd.toISOString()}`
                );

                /**
                 * Filter logic:
                 * - status recall statuslardan biri
                 * - recallDate shu soat oralig'ida
                 * - shu soatda 2 marta bump bo'lmasin:
                 *   - recallBumpedAt yo'q yoki hourStart'dan oldin
                 *   - (fallback) newTime yo'q/null yoki hourStart'dan oldin
                 */
                const filter = {
                    status: { $in: RECALL_STATUSES },
                    recallDate: { $gte: hourStart, $lt: hourEnd },
                    $and: [
                        {
                            $or: [
                                { recallBumpedAt: { $exists: false } },
                                { recallBumpedAt: null },
                                { recallBumpedAt: { $lt: hourStart } },
                            ],
                        },
                        {
                            $or: [
                                { newTime: { $exists: false } },
                                { newTime: null },
                                { newTime: { $lt: hourStart } },
                            ],
                        },
                    ],
                };

                // 1) Targets (history uchun)
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
                            // ideal field (bo'lmasa ham zarar qilmaydi)
                            'recallBumpedAt',
                        ].join(' ')
                    )
                    .lean();

                if (!targets.length) {
                    console.log('[CRON] recall bump: no targets');
                    console.log('[CRON] lead recall bump finished');
                    return;
                }

                // ✅ Extra safety: local check (har ehtimolga qarshi)
                const eligible = targets.filter((t) => canBumpOncePerHour(t, hourStart));

                if (!eligible.length) {
                    console.log('[CRON] recall bump: targets found but none eligible (already bumped this hour)');
                    console.log('[CRON] lead recall bump finished');
                    return;
                }

                const ids = eligible.map((t) => t._id);

                // 2) Update (update filter ham "once per hour" bo'lsin)
                const updateRes = await LeadModel.updateMany(
                    {
                        _id: { $in: ids },
                        status: { $in: RECALL_STATUSES },
                        recallDate: { $gte: hourStart, $lt: hourEnd },
                        $and: [
                            {
                                $or: [
                                    { recallBumpedAt: { $exists: false } },
                                    { recallBumpedAt: null },
                                    { recallBumpedAt: { $lt: hourStart } },
                                ],
                            },
                            {
                                $or: [
                                    { newTime: { $exists: false } },
                                    { newTime: null },
                                    { newTime: { $lt: hourStart } },
                                ],
                            },
                        ],
                    },
                    {
                        $set: {
                            newTime: now,

                            // universal flaglar (sizning sistemangizga mos)
                            consideringBumped: true,
                            consideringBumpedAt: now,
                            consideringBumpedReason: 'RecallDate',

                            // recall cron uchun alohida marker (eng toza idempotency)
                            recallBumpedAt: now,

                            updatedAt: now,
                        },
                    }
                );

                const modified = updateRes?.modifiedCount ?? updateRes?.nModified ?? 0;

                // 3) History (bulk)
                const chatEvents = eligible.map((lead) => {
                    const prevNewTime = pickPrevNewTime(lead);

                    return {
                        leadId: lead._id,

                        type: 'event',
                        isSystem: true,
                        action: 'field_changed', // sizda status_changed bo'lsa ham bo'ladi
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
                    await LeadChatModel.insertMany(chatEvents, { ordered: false });
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
