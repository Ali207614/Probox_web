const cron = require('node-cron');
const moment = require('moment');
const Lead = require('../models/lead-model');
const LeadChat = require('../models/lead-chat-model');
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

const SOURCE_NAME = 'Mehrli Qongiroq';
const MAX_LEADS_PER_DAY = 5;
const TARGET_OPERATOR_CODE = 58;

/**
 * Mehrli Qo'ng'iroq cron jarayonini ishga tushiruvchi funksiya
 */
function startMehrliCallJob() {
    cron.schedule(
        '58 15 * * *',
        async () => {
            try {
                console.log('[CRON] Mehrli Qongiroq job started');

                // 1) SQL dan nomzodlarni olish
                const sql = DataRepositories.getMehrliQongiroqCandidates();
                let rows = await dbService.execute(sql);

                if (!Array.isArray(rows) || !rows.length) {
                    console.log('[CRON] Bugun uchun Mehrli Qongiroqqa nomzodlar topilmadi.');
                    return;
                }

                const todayStr = moment().format('YYYY_MM_DD');
                const toCreate = [];
                const seenCardCodes = new Set();
                const operations = [];

                // 2) Ma'lumotlarni saralash (Max 20 ta, dublikatlarsiz)
                for (const row of rows) {
                    const cardCode = String(row.CardCode || '').trim();
                    if (!cardCode || seenCardCodes.has(cardCode)) continue;

                    seenCardCodes.add(cardCode);
                    toCreate.push(row);

                    if (toCreate.length >= MAX_LEADS_PER_DAY) break;
                }

                // 3) Lead'larni DB ga Upsert qilish
                for (const r of toCreate) {
                    const uniqueId = `MEHRLI_${r.CardCode}_${todayStr}`;

                    operations.push({
                        updateOne: {
                            filter: { uniqueId },
                            update: {
                                $setOnInsert: {
                                    uniqueId,
                                    source: SOURCE_NAME,
                                    status: 'Active',
                                    cardCode: r.CardCode,
                                    cardName: r.CardName,
                                    clientName: r.CardName,
                                    clientPhone: r.Phone1 || null,
                                    clientPhone2: r.Phone2 || null,
                                    passportId: r.Cellular || null,
                                    time: new Date(),
                                    operator: TARGET_OPERATOR_CODE,
                                }
                            },
                            upsert: true
                        }
                    });
                }

                if (!operations.length) return;

                const result = await Lead.bulkWrite(operations, { ordered: false });
                console.log(`[CRON] Leads processed: Upserted=${result.upsertedCount}, Matched=${result.matchedCount}`);

                // 4) Yangi leadlar uchun LeadChat yozuvlarini yaratish
                if (result.upsertedCount > 0) {
                    const insertedIds = Object.values(result.upsertedIds);
                    const newLeads = await Lead.find({ _id: { $in: insertedIds } }).lean();

                    const chatOps = [];
                    const currencyFormatter = new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                        minimumFractionDigits: 2
                    });

                    for (const lead of newLeads) {
                        const rowData = toCreate.find(r => r.CardCode === lead.cardCode);
                        if (!rowData) continue;

                        let messageText = '';
                        let eventId = '';
                        const formattedAmount = new Intl.NumberFormat('en-US', {
                            style: 'currency',
                            currency: 'USD'
                        }).format(rowData.Amount || 0);

                        if (rowData.EventType === 'NEW_SALE') {
                            messageText = `Mijoz kecha yangi xaridni amalga oshirdi.\n` +
                                `Tovar: ${rowData.ItemNames}\n` +
                                `Summa: ${formattedAmount}\n\n` +
                                `Xarid qilgan`; // Oxiriga qo'shildi
                            eventId = `SALE_${rowData.DocEntry}`;
                        }
                        else if (rowData.EventType === 'PAYMENT') {
                            const total = rowData.TotalInstlmnt || 0;
                            const current = rowData.InstlmntID || 0;

                            messageText = `Mijoz kecha oylik to'lovni o'z vaqtida amalga oshirdi.\n` +
                                `Tovar: ${rowData.ItemNames}\n` +
                                `Summa: ${formattedAmount}\n` +
                                `To'lov: ${total} / ${current}-chi to'lov to'landi.\n\n` +
                                `To'lov to'lagan`; // Oxiriga qo'shildi
                            eventId = `PAYMENT_${rowData.DocEntry}_${current}`;
                        }

                        chatOps.push({
                            leadId: lead._id,
                            type: 'event',
                            action: 'note',
                            createdBy: 0,
                            isSystem: true,
                            message: messageText,
                            eventId: eventId,
                            time: new Date()
                        });
                    }

                    if (chatOps.length > 0) {
                        await LeadChat.insertMany(chatOps);
                        console.log(`[CRON] ${chatOps.length} ta LeadChat tarixi yaratildi.`);
                    }
                }

                console.log('[CRON] Mehrli Qongiroq job finished successfully');

            } catch (e) {
                console.error('[CRON] Mehrli Qongiroq Error:', e);
            }
        },
        { timezone: 'Asia/Tashkent' }
    );
}

module.exports = startMehrliCallJob;