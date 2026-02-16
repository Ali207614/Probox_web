'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');

function startConsideringBumpCron() {
    cron.schedule(
        '20 16 * * *',
        async () => {
            try {
                console.log('[CRON] considering bump started --------------------------------------------------------');

                return
                const now = new Date();
               // const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 soat
                const cutoff = new Date(now.getTime() - 10 * 1000); // 10 sekund
              //  const cutoff = new Date(now.getTime() - 60 * 1000); // 1 minut

                const res = await LeadModel.updateMany(
                    {
                        status: 'Considering',
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
                            consideringBumped: true,
                            consideringBumpedAt: now,
                            updatedAt: now,
                        },
                    }
                );

                const modified = res?.modifiedCount ?? res?.nModified ?? 0;
                console.log(`[CRON] considering bump done. modified=${modified}`);
            } catch (err) {
                console.error('[CRON] considering bump error:', err);
            }
        },
        { timezone: 'Asia/Tashkent' }
    );
}

module.exports = { startConsideringBumpCron };
