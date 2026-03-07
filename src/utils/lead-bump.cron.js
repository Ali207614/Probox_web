'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model'); // ✅ history shu yerga

// ✅ Faqat shu sanadan boshlab yaratilgan leadlar ishlanadi
const BUMP_MIN_DATE = new Date(process.env.BUMP_MIN_DATE || '2026-02-01T00:00:00+05:00');


function startLeadBumpCron() {
    cron.schedule(
        '0 10 * * *',
        async () => {
            try {
                console.log('[CRON] lead bump started --------------------------------------------------------');

                const now = new Date();

                const RULES = [
                    { statuses: ['Considering'], hours: 8, reason: 'Considering' },
                    { statuses: ['Missed', 'Ignored', 'NoAnswer' ], hours: 1, reason: 'MissedIgnored' },
                ];

                for (const rule of RULES) {
                    const cutoff = new Date(now.getTime() - rule.hours * 60 * 60 * 1000);

                    // ✅ filter: statusChangedAt bo'lsa shuni oladi, bo'lmasa newTime/time
                    // ✅ createdAt >= BUMP_MIN_DATE — faqat fevraldan keyingi leadlar
                    const filter = {
                        status: { $in: rule.statuses },
                        createdAt: { $gte: BUMP_MIN_DATE }, // ✅ fevraldan boshlab
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