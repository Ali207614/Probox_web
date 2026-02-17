'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model'); // ✅ history shu yerga

// ✅ history uchun "qachondan beri" hisoblash (debugga ham foydali)
function getSinceDate(lead) {
    return (
        lead.statusChangedAt ||
        lead.newTime ||
        lead.time ||
        lead.createdAt ||
        lead.updatedAt ||
        null
    );
}

function startLeadBumpCron() {
    cron.schedule(
        '0 10 * * *',
        async () => {
            try {
                console.log('[CRON] lead bump started --------------------------------------------------------');

                const now = new Date();

                const RULES = [
                    { statuses: ['Considering'], hours: 8, reason: 'Considering' },
                    { statuses: ['Missed', 'Ignored'], hours: 1, reason: 'MissedIgnored' },
                ];




                for (const rule of RULES) {
                    const cutoff = new Date(now.getTime() - rule.hours * 60 * 60 * 1000);

                    // ✅ filter: statusChangedAt bo'lsa shuni oladi, bo'lmasa newTime/time
                    const filter = {
                        status: { $in: rule.statuses },
                        $expr: {
                            $lt: [
                                {
                                    $ifNull: [
                                        '$statusChangedAt',
                                        { $ifNull: ['$newTime', '$time'] },
                                    ],
                                },
                                cutoff,
                            ],
                        },
                    };

                    // 1) ✅ targets (history uchun kerak)
                    const targets = await LeadModel.find(filter)
                        .select(
                            [
                                '_id',
                                'n',
                                'status',
                                'time',
                                'newTime',
                                'statusChangedAt',
                                'operator',
                                'createdAt',
                                'updatedAt',
                                'consideringBumped',
                                'consideringBumpedReason',
                            ].join(' ')
                        )
                        .lean();

                    if (!targets.length) {
                        console.log(`[CRON] bump ${rule.reason}: no targets`);
                        continue;
                    }

                    const ids = targets.map((t) => t._id);

                    // 2) ✅ updateMany (tez)
                    const updateRes = await LeadModel.updateMany(
                        { _id: { $in: ids } },
                        {
                            $set: {
                                newTime: now,

                                // ✅ universal flag
                                consideringBumped: true,
                                consideringBumpedAt: now,
                                consideringBumpedReason: rule.reason,

                                updatedAt: now,
                            },
                        }
                    );

                    const modified = updateRes?.modifiedCount ?? updateRes?.nModified ?? 0;

                    // 3) ✅ LeadChat history (bulk)
                    const chatEvents = targets.map((lead) => {
                        const prevNewTime = lead.newTime || lead.time || null;

                        return {
                            leadId: lead._id,

                            type: 'event',
                            isSystem: true,
                            action: 'field_changed',
                            createdBy: 0,
                            message: `Tizim: lead tepaga ko'tarildi (${rule.reason}).`,

                            changes: [
                                { field: 'newTime', from: prevNewTime, to: now },
                                { field: 'consideringBumped', from: !!lead.consideringBumped, to: true },
                                { field: 'consideringBumpedReason', from: lead.consideringBumpedReason || null, to: rule.reason },
                            ],

                            createdAt: now,
                            updatedAt: now,
                        };
                    });

                    try {
                        await LeadChatModel.insertMany(chatEvents, { ordered: false });
                    } catch (e) {
                        // history yozishda muammo bo'lsa ham cron davom etsin
                        console.error(`[CRON] bump ${rule.reason}: history insert error:`, e?.message || e);
                    }

                    console.log(
                        `[CRON] bump ${rule.reason} done. targets=${targets.length} modified=${modified} history=${chatEvents.length}`
                    );
                }

                console.log('[CRON] lead bump finished --------------------------------------------------------');
            } catch (err) {
                console.error('[CRON] lead bump error:', err);
            }
        },
        { timezone: 'Asia/Tashkent' }
    );
}

module.exports = { startLeadBumpCron };

// Qayta aloqa
// Do'konga boradi
// Passport yuboradi