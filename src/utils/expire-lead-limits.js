const cron = require('node-cron');

const LeadModel = require('../models/lead-model');

const TIMEZONE = 'Asia/Tashkent';
const DAYS = 10;

async function expireLeadLimits() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);

    try {
        const filter = {
            limitDate: { $ne: null, $lte: cutoff },
            $or: [
                { finalLimit: { $gt: 0 } },
                { finalPercentage: { $gt: 0 } },
            ],
        };

        const update = {
            $set: {
                finalLimit: 0,
                finalPercentage: 0,
                limitDate: null,
                updatedAt: new Date(),
            },
        };

        const result = await LeadModel.updateMany(filter, update);

        console.log(
            `[expireLeadLimits] cutoff=${cutoff.toISOString()} matched=${result.matchedCount} modified=${result.modifiedCount}`
        );
    } catch (err) {
        console.error('[expireLeadLimits] Error:', err);
    }
}

// Har kuni 00:10 da ishga tushadi (Tashkent time)
function startExpireLeadLimitsCron() {
    cron.schedule(
        '10 0 * * *',
        () => {
            expireLeadLimits();
        },
        { timezone: TIMEZONE }
    );

    console.log('[expireLeadLimits] Cron scheduled: every day 00:10 (Asia/Tashkent)');
}

module.exports = { startExpireLeadLimitsCron, expireLeadLimits };
