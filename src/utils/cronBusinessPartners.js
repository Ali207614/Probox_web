const cron = require('node-cron');
const moment = require('moment');
const Lead = require('../models/lead-model');
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

const BATCH_SIZE = 10;
const SOURCE_NAME = 'Qayta sotuv';

// Round-robin scoring index (in-memory)
let lastScoringIndex = -1;

// Socket.io instance — server.js dan setIo() orqali o'rnatiladi
let ioInstance = null;

/**
 * Socket.io instance ni tashqaridan ulash uchun
 * @param {import('socket.io').Server} io
 */
function setIo(io) {
    ioInstance = io;
}

/**
 * Scoring operatorlar ro'yxatini SAP/HANA dan olish
 * @returns {Promise<Array>}
 */
async function loadOperators() {
    try {
        const sql = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const data = await dbService.execute(sql);
        return Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('[CRON] Failed to load operators:', err.message);
        return [];
    }
}

/**
 * Round-robin bilan navbatdagi scoring operatorni tanlash
 * @param {Array} operators
 * @returns {number|null} SlpCode
 */
function nextScoringOperator(operators) {
    if (!operators.length) return null;
    lastScoringIndex = (lastScoringIndex + 1) % operators.length;
    return operators[lastScoringIndex]?.SlpCode || null;
}

/**
 * Yangi yaratilgan leadlarga scoring_lead eventini emit qilish
 * @param {Array<string>} uniqueIds
 */
async function emitScoringLeads(uniqueIds) {
    if (!ioInstance || !uniqueIds.length) return;

    try {
        const newLeads = await Lead.find({
            uniqueId: { $in: uniqueIds },
            operator: { $ne: null },
        }).lean();

        for (const lead of newLeads) {
            ioInstance.emit('scoring_lead', {
                n: lead.n,
                _id: lead._id,
                source: lead.source,
                clientName: lead.clientName,
                time: lead.time,
                clientPhone: lead.clientPhone,
                SlpCode: lead.scoring,
            });
        }

        console.log(`[CRON] Emitted scoring_lead for ${newLeads.length} leads`);
    } catch (err) {
        console.error('[CRON] Failed to emit scoring leads:', err.message);
    }
}

// ─── CRON JOB: Har minutda ishga tushadi ───────────────────────────────────────
cron.schedule(
    '0 10 * * *',
    async () => {
        try {
            console.log('[CRON] High limit lead job started');

            // 1) Kandidatlarni SAP/HANA dan olish
            const sql = DataRepositories.getAllHighLimitCandidatesByCardCode();
            const rows = await dbService.execute(sql);
            const total = Array.isArray(rows) ? rows.length : 0;

            console.log(`[CRON] Candidates found: ${total}`);

            if (!total) {
                console.log('[CRON] No candidates');
                return;
            }

            // 2) Scoring operatorlarni oldindan yuklash
            const scoringOperators = await loadOperators();

            if (!scoringOperators.length) {
                console.warn('[CRON] No scoring operators available, leads will be created without scoring');
            }

            // 3) Shu oy uchun dedupe
            //    uniqueId = AUTO_LIMIT_{cardCode}_{YYYY_MM}
            //    Yangi oy boshlanganda YYYY_MM o'zgaradi → shu cardCode qayta yaratiladi
            const currentYm = moment().format('YYYY_MM');
            const monthStart = moment().startOf('month').toDate();
            const monthEnd = moment().endOf('month').toDate();

            const recentLeads = await Lead.find(
                {
                    source: SOURCE_NAME,
                    createdAt: { $gte: monthStart, $lte: monthEnd },
                    uniqueId: { $regex: `^AUTO_LIMIT_.*_${currentYm}$` },
                    cardCode: { $ne: null },
                },
                { cardCode: 1 }
            ).lean();

            const alreadyThisMonth = new Set(
                recentLeads.map((x) => String(x.cardCode))
            );

            console.log(`[CRON] Already created this month: ${alreadyThisMonth.size}`);

            // 4) Batch tanlash — duplicate cardCode'larni chiqarib tashlash
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
                console.log(`[CRON] No unique new leads for ${currentYm}`);
                return;
            }

            // 5) Bulk upsert — har bir leadga scoring tayinlab
            const createdUniqueIds = [];

            const ops = toCreate.map((r) => {
                const cardCode = String(r.CardCode || '').trim();
                const uniqueId = `AUTO_LIMIT_${cardCode}_${currentYm}`;
                const operator = nextScoringOperator(scoringOperators);

                createdUniqueIds.push(uniqueId);

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
                                clientPhone: String(r.Phone1 || '').trim() || null,
                                clientPhone2: String(r.Phone2 || '').trim() || null,
                                address: null,
                                address2: r.address2 ?? null,
                                finalLimit: null,
                                finalPercentage: null,
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
                                operator,
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
            const created = Number(result?.upsertedCount || 0);

            console.log('[CRON] bulkWrite result:', {
                matched: result?.matchedCount,
                modified: result?.modifiedCount,
                upserted: result?.upsertedCount,
            });

            // 6) Yangi yaratilgan leadlarga scoring_lead emit
            if (created > 0) {
                await emitScoringLeads(createdUniqueIds);
            }

            console.log(
                `[CRON] Done. created=${created}, batch=${toCreate.length}, candidates=${total}`
            );
        } catch (e) {
            console.error('[CRON] Error:', e);
        }
    },
    { timezone: 'Asia/Tashkent' }
);

module.exports = { setIo };