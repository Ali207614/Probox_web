const cron = require('node-cron');
const moment = require('moment');
const Lead = require('../models/lead-model');
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

const BATCH_SIZE = 10;          // har run 20 ta
const SOURCE_NAME = 'Qayta sotuv';

cron.schedule(
    '* * * * *', // har minut
    async () => {
        try {
            console.log('[CRON] High limit lead job started');
            const res = await Lead.deleteMany({ source: 'Qayta sotuv' });
            console.log('Deleted:', res.deletedCount);

            // 1) Kandidatlar (SAP/HANA)
            const sql = DataRepositories.getAllHighLimitCandidatesByCardCode();
            const rows = await dbService.execute(sql);

            console.log(rows.length)

            const total = Array.isArray(rows) ? rows.length : 0;
            console.log(total, '[CRON] Candidates found');

            if (!total) {
                console.log('[CRON] No candidates');
                return;
            }

            return

            // 2) Shu oy uchun dedupe
            const currentYm = moment().format('YYYY_MM');
            const monthStart = moment().startOf('month').toDate();
            const monthEnd = moment().endOf('month').toDate();

            // Shu oy ichida AUTO_LIMIT_*_{YYYY_MM} uniqueId bilan yaratilgan leadlar cardCode’lari
            const recentLeads = await Lead.find(
                {
                    source: SOURCE_NAME,
                    createdAt: { $gte: monthStart, $lte: monthEnd },
                    uniqueId: { $regex: `^AUTO_LIMIT_.*_${currentYm}$` },
                    cardCode: { $ne: null },
                },
                { cardCode: 1 }
            ).lean();

            const alreadyThisMonth = new Set(recentLeads.map((x) => String(x.cardCode)));

            // 3) Batch tanlash (20 ta), rows ichidagi duplicate cardCode’larni ham chiqarib tashlaymiz
            const toCreate = [];
            const seenInThisRun = new Set();

            for (const r of rows) {
                const cardCode = String(r?.CardCode || '').trim();
                if (!cardCode) continue;

                if (alreadyThisMonth.has(cardCode)) continue;
                if (seenInThisRun.has(cardCode)) continue;

                toCreate.push(r);
                seenInThisRun.add(cardCode);

                if (toCreate.length >= BATCH_SIZE) break;
            }

            if (!toCreate.length) {
                console.log(`✅ No unique new leads found for ${currentYm}.`);
                return;
            }

            // 4) Bulk upsert (insert-only)
            const ops = toCreate.map((r) => {
                const cardCode = String(r.CardCode || '').trim();
                const uniqueId = `AUTO_LIMIT_${cardCode}_${currentYm}`; // ✅ oylik uniqueId

                return {
                    updateOne: {
                        filter: { uniqueId },
                        update: {
                            $setOnInsert: {
                                uniqueId,
                                source: SOURCE_NAME,
                                cardCode,
                                cardName: r.CardName ?? null,
                                clientName: r.CardName ?? null,
                                clientPhone: String( r.Phone1 || '').trim() || null,
                                clientPhone2: String(r.Phone2 || '').trim() || null,
                                address: null,
                                address2: r.address2 ?? null,
                                finalLimit:null,
                                finalPercentage:null,
                                jshshir: String(r.jshshir || '').trim() || null,
                                limit: Number(r.limit) || 0,

                                paymentScore: String(r.score ?? ''),

                                passportId: r.Cellular || null,

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
                        upsert: true,
                    },
                };
            });

            const result = await Lead.bulkWrite(ops, { ordered: false });

            // bulkWrite natijalari:
            // insertedCount odatda bo‘lmaydi, lekin upsertedCount bor
            const created = Number(result?.upsertedCount || 0);

            console.log('[CRON] bulkWrite result:', {
                matched: result?.matchedCount,
                modified: result?.modifiedCount,
                upserted: result?.upsertedCount,
            });

            console.log(
                `[CRON] Done. created=${created}, batch=${toCreate.length}, candidates=${total}`
            );
        } catch (e) {
            console.error('[CRON] Error:', e);
        }
    },
    { timezone: 'Asia/Tashkent' }
);
