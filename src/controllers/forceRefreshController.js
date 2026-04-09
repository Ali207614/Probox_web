const RefreshFlag = require('../models/refresh-flag-model');
const ApiError = require('../exceptions/api-error');
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

class ForceRefreshController {
    setForUser = async (req, res, next) => {
        try {
            const { slpCode } = req.body;
            if (slpCode == null) {
                return next(ApiError.BadRequest('slpCode majburiy'));
            }

            await RefreshFlag.findOneAndUpdate(
                { slpCode },
                { slpCode, force_refresh: true },
                { upsert: true, new: true }
            );

            const io = req.app.get('io');
            if (io) {
                io.to(`slp:${slpCode}`).emit('force-refresh', {
                    message: 'Iltimos, sahifani yangilang',
                });
            }

            return res.json({ success: true });
        } catch (e) {
            next(e);
        }
    };

    setForAll = async (req, res, next) => {
        try {
            // 1) HANA'dan barcha SlpCode larni olamiz
            const query = await DataRepositories.getAllSalesManagers();
            const rows = await dbService.execute(query);

            const slpCodes = (rows || [])
                .map((r) => r.SlpCode)
                .filter((c) => c != null);

            // 2) Har bir user uchun RefreshFlag = true qilib upsert qilamiz
            if (slpCodes.length > 0) {
                await RefreshFlag.bulkWrite(
                    slpCodes.map((slpCode) => ({
                        updateOne: {
                            filter: { slpCode },
                            update: { $set: { slpCode, force_refresh: true } },
                            upsert: true,
                        },
                    }))
                );
            }

            // 3) Online userlarga darhol event jo'natamiz
            const io = req.app.get('io');
            if (io) {
                io.emit('force-refresh', {
                    message: 'Iltimos, sahifani yangilang',
                });
            }

            return res.json({ success: true, total: slpCodes.length });
        } catch (e) {
            next(e);
        }
    };
}

module.exports = new ForceRefreshController();
