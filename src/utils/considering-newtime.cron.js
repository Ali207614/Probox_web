const cron = require('node-cron');
const LeadModel = require('../models/lead-model');

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

// Har kuni 09:00 da (server timezone bo'yicha)
cron.schedule('0 9 * * *', async () => {
    try {
        const todayStart = startOfToday();
        const now = new Date();

        const result = await LeadModel.updateMany(
            {
                status: 'Considering',
                $or: [
                    { newTime: { $exists: false } },
                    { newTime: null },
                    { newTime: { $lt: todayStart } },
                ],
            },
            {
                $set: { newTime: now },
            }
        );

        console.log('[cron] Considering newTime updated:', result.modifiedCount ?? result.nModified);
    } catch (e) {
        console.error('[cron] Considering newTime update error:', e);
    }
});
