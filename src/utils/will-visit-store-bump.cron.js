'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');

function startWillVisitStoreBumpCron() {
    cron.schedule(
        '0 10 * * *', // har kuni 10:00
        async () => {
            try {
                console.log('[CRON] willVisitStore bump started --------------------------------------------');

                const now = new Date();
                const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000); // ✅ 48 soat

                const res = await LeadModel.updateMany(
                    {
                        status: 'WillVisitStore',
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
                    },
                    {
                        $set: {
                            newTime: now,

                            // ✅ yangi flag (frontend rang uchun)
                            willVisitStoreBumped: true,
                            willVisitStoreBumpedAt: now,

                            updatedAt: now,
                        },
                    }
                );

                const modified = res?.modifiedCount ?? res?.nModified ?? 0;
                console.log(`[CRON] willVisitStore bump done. modified=${modified}`);
            } catch (err) {
                console.error('[CRON] willVisitStore bump error:', err);
            }
        },
        { timezone: 'Asia/Tashkent' }
    );
}

module.exports = { startWillVisitStoreBumpCron };
