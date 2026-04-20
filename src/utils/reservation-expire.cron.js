const cron = require('node-cron');
const ReservationModel = require('../models/reservation-model');

function startReservationExpireCron() {
    cron.schedule('*/5 * * * *', async () => {
        try {
            const now = new Date();
            const result = await ReservationModel.updateMany(
                { status: 'active', expiresAt: { $lte: now } },
                {
                    $set: {
                        status: 'expired',
                        releaseReason: 'expired',
                        releasedAt: now,
                    },
                }
            );

            if (result.modifiedCount > 0) {
                console.log(`♻️  Reservation expire: ${result.modifiedCount} bronlar muddati tugadi`);
            }
        } catch (err) {
            console.error('❌ Reservation expire cron error:', err?.message);
        }
    }, { timezone: 'Asia/Tashkent' });
}

module.exports = { startReservationExpireCron };
