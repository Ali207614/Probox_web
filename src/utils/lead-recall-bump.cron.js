'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

const TZ = 'Asia/Tashkent';
const RECALL_STATUSES = ['FollowUp', 'WillVisitStore', 'WillSendPassport'];

function pickPrevNewTime(lead) {
    return lead.newTime || lead.time || lead.createdAt || null;
}

// ✅ Shu recallDate uchun allaqachon bump bo'lganmi-yo'qmi
function canBumpForRecall(lead, now) {
    if (!lead?.recallDate) return false;

    const recallDate = new Date(lead.recallDate);
    if (Number.isNaN(recallDate.getTime())) return false;

    // recallDate hali kelmagan bo'lsa bump qilmaymiz
    if (recallDate > now) return false;

    const rb = lead.recallBumpedAt ? new Date(lead.recallBumpedAt) : null;

    // recallBumpedAt recallDate'dan keyin/ga teng bo'lsa => shu recall uchun bump bo'lgan
    if (rb && rb >= recallDate) return false;

    return true;
}

function startLeadRecallBumpCron() {
    cron.schedule(
        '*/5 * * * *', // ✅ har 5 minutda
        async () => {
            const now = new Date();

            try {
                console.log(`[CRON] lead recall bump started | now=${now.toISOString()}`);

                /**
                 * Filter logic:
                 * - status recall statuslardan biri
                 * - recallDate kelgan (<= now)
                 * - shu recallDate uchun hali bump qilinmagan:
                 *   recallBumpedAt yo'q yoki recallDate'dan eski
                 */
                const filter = {
                    status: { $in: RECALL_STATUSES },
                    recallDate: { $ne: null, $lte: now },
                    $or: [
                        { recallBumpedAt: { $exists: false } },
                        { recallBumpedAt: null },
                        { $expr: { $lt: ['$recallBumpedAt', '$recallDate'] } }, // ✅ Mongo expression
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

                // ✅ Extra safety (local check)
                const eligible = targets.filter((t) => canBumpForRecall(t, now));

                if (!eligible.length) {
                    console.log('[CRON] recall bump: targets found but none eligible');
                    console.log('[CRON] lead recall bump finished');
                    return;
                }

                const ids = eligible.map((t) => t._id);

                // ✅ update filter ham xuddi shu idempotent shart bilan
                const updateRes = await LeadModel.updateMany(
                    {
                        _id: { $in: ids },
                        status: { $in: RECALL_STATUSES },
                        recallDate: { $ne: null, $lte: now },
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