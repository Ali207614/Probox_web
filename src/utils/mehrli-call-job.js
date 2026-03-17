const cron = require('node-cron');
const moment = require('moment');
const Lead = require('../models/lead-model');
const LeadChat = require('../models/lead-chat-model'); // LeadChat modelingiz yo'li
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

const SOURCE_NAME = 'Mehrli Qongiroq';
const MAX_LEADS_PER_DAY = 20;
const TARGET_OPERATOR_CODE = 58;

// Vaqtincha ishlatilmayotgan bo'lsa ham, kelajakda kerak bo'lishi mumkinligi uchun qoldirildi
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

// let lastScoringIndex = -1; // Agar qachondir ochsangiz, buni ham global scope'da ochish esdan chiqmasin
function nextScoringOperator(operators) {
    if (!operators.length) return null;
    lastScoringIndex = (lastScoringIndex + 1) % operators.length;
    return operators[lastScoringIndex]?.SlpCode || null;
}

/**
 * Mehrli Qo'ng'iroq cron jarayonini ishga tushiruvchi funksiya
 */
function startMehrliCallJob() {
    cron.schedule(
        '52 14 * * *',
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
                const newUniqueIds = [];

                // 2) Ma'lumotlarni tayyorlash (Max 100 ta, dublikatlarsiz)
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
                    newUniqueIds.push(uniqueId);

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

                if (!operations.length) {
                    console.log('[CRON] Yaratish uchun yangi mijozlar topilmadi.');
                    return;
                }

                const result = await Lead.bulkWrite(operations, { ordered: false });
                console.log(`[CRON] Leads processed: Upserted=${result.upsertedCount}, Matched=${result.matchedCount}`);

                // 4) Agar yangi lead yaratilgan bo'lsa, LeadChat ga yozuv qoldiramiz
                if (result.upsertedCount > 0) {
                    const insertedIds = Object.values(result.upsertedIds);
                    const newLeads = await Lead.find({ _id: { $in: insertedIds } }).lean();

                    const chatOps = [];

                    for (const lead of newLeads) {
                        const rowData = toCreate.find(r => r.CardCode === lead.cardCode);
                        if (!rowData) continue;

                        let messageText = '';
                        let eventId = '';

                        if (rowData.EventType === 'NEW_SALE') {
                            messageText = `Mijoz kecha yangi xaridni amalga oshirdi. Tovar: ${rowData.ItemNames}. Summa: ${Number(rowData.Amount).toLocaleString()} so'm.`;
                            eventId = `SALE_${rowData.DocEntry}`; // Unikal ID
                        } else if (rowData.EventType === 'PAYMENT') {
                            messageText = `Mijoz kecha oylik to'lovni o'z vaqtida amalga oshirdi. Tovar: ${rowData.ItemNames}. Summa: ${Number(rowData.Amount).toLocaleString()} so'm. Oylik: ${rowData.InstlmntID}-oy.`;
                            eventId = `PAYMENT_${rowData.DocEntry}_${rowData.InstlmntID}`; // Unikal ID
                        }

                        chatOps.push({
                            leadId: lead._id,
                            type: 'event',
                            action: 'note',
                            createdBy: 0, // System
                            isSystem: true,
                            message: messageText,
                            eventId: eventId
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