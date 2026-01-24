const cron = require('node-cron');
const moment = require('moment');
const Lead = require('../models/lead-model');
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

cron.schedule(
    '* * * * *',
    async () => {
        try {
            console.log('[CRON] High limit lead job started');

            const sql = DataRepositories.getAllHighLimitCandidatesByCardCode();
            const rows = await dbService.execute(sql);
            console.log(rows.length, '[CRON] Candidates found')
            console.log(rows.slice(0,5), '[CRON] Sample candidates')
            if (!rows?.length) {
                console.log('[CRON] No candidates');
                return;
            }

            const since = moment().subtract(30, 'days').toDate();

            const recentLeads = await Lead.find(
                {
                    createdAt: { $gte: since },
                    cardCode: { $ne: null },
                },
                { cardCode: 1 }
            ).lean();

            const recentSet = new Set(recentLeads.map(x => String(x.cardCode)));

            let created = 0;
            let skipped = 0;

            for (const r of rows) {
                const cardCode = String(r.CardCode || '').trim();
                if (!cardCode) {
                    skipped++;
                    continue;
                }

                if (recentSet.has(cardCode)) {
                    skipped++;
                    continue;
                }

                const uniqueId = `AUTO_LIMIT_${cardCode}`;

                await Lead.updateOne(
                    { uniqueId },
                    {
                        $setOnInsert: {
                            uniqueId,

                            cardCode,
                            cardName: r.CardName ?? null,

                            limit: Number(r.limit) || 0,
                            paymentScore: String(r.score ?? ''),

                            totalContracts: String(r.totalContracts ?? ''),
                            openContracts: String(r.openContracts ?? ''),
                            totalAmount: String(r.totalAmount ?? ''),
                            totalPaid: String(r.totalPaid ?? ''),
                            overdueDebt: String(r.overdueDebt ?? ''),
                            maxDelay: String(r.maxDelay ?? ''),
                            avgPaymentDelay: String(r.avgPaymentDelay ?? ''),

                            time: new Date(),
                            status: 'Active',

                            // defaultlar
                            seen: null,
                            called: false,
                            answered: false,
                            callCount: 0,
                            invoiceCreated: false,
                            invoiceDocEntry: null,
                            invoiceDocNum: null,
                            invoiceCreatedAt: null,
                        },
                    },
                    { upsert: true }
                );

                recentSet.add(cardCode);
                created++;
            }

            console.log(`[CRON] Done. created=${created}, skipped=${skipped}`);
        } catch (e) {
            console.error('[CRON] Error:', e);
        }
    },
    { timezone: 'Asia/Tashkent' }
);
