'use strict';

const path = require('path');
const moment = require('moment');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { get } = require('lodash');

require('dotenv').config();

const LeadModel = require('../models/lead-model');
const DataRepositories = require('../repositories/dataRepositories');
const b1Controller = require('../controllers/b1HANA');
const LeadChat = require('../models/lead-chat-model');
const { ALLOWED_STATUSES } = require('../config');

/**
 * =========================
 * Small utils
 * =========================
 */
function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

/**
 * Returns ONLY local 9 digits (e.g. 901234567)
 */
function normalizePhone(input) {
    if (!input) return null;

    let digits = digitsOnly(input);

    if (digits.startsWith('998')) digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1);

    if (digits.length !== 9) return null;
    return digits;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/**
 * Excel serial OR dd.mm.yyyy [HH:mm[:ss]]
 */
function parseSheetDate(value) {
    if (!value) return moment().utcOffset(5).toDate();

    const cleaned = String(value)
        .trim()
        .replace(/[\/\\]/g, '.')
        .replace(/\u00A0/g, ' ')
        .replace(/\u200B/g, '')
        .replace(/\s+/g, ' ');

    // Excel numeric date
    if (!isNaN(cleaned) && cleaned !== '') {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const date = new Date(excelEpoch.getTime() + Number(cleaned) * 86400000);
        return moment(date).utcOffset(5).toDate();
    }

    const formats = ['DD.MM.YYYY HH:mm:ss', 'DD.MM.YYYY HH:mm', 'DD.MM.YYYY'];

    let parsed = moment(cleaned, formats, true);
    if (!parsed.isValid()) parsed = moment(cleaned, formats);

    if (!parsed.isValid()) return moment().utcOffset(5).toDate();

    return parsed.utcOffset(5, true).toDate();
}

function getWeekdaySafe(dateLike) {
    let m = moment(dateLike);
    if (!m.isValid()) m = moment();

    if (m.hour() >= 19) return m.add(1, 'day').isoWeekday().toString();
    return m.isoWeekday().toString();
}

const DEDUP_WINDOW_DAYS = Number(process.env.DEDUP_WINDOW_DAYS || 2);
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function buildPhoneCandidates(rawLocal9) {
    const local9 = digitsOnly(rawLocal9);
    if (local9.length !== 9) {
        return { phoneCandidates: [], legacyRegex: null };
    }

    const full = `998${local9}`;
    const phoneCandidates = [local9, full];
    const legacyRegex = new RegExp(`${local9}$`);

    return { phoneCandidates, legacyRegex };
}

function buildLoosePhoneRegexFromLocal9(local9) {
    if (!local9) return null;
    const pat = local9.split('').join('\\D*');
    return new RegExp(pat);
}

/**
 * Dedup filter:
 * - allowed statuses
 * - createdAt >= sinceDedup (optional)
 * - phone candidates OR legacy regex OR loose regex
 * - source filter optional
 */
function buildDedupFilter({ sinceDedup, phoneCandidates, legacyRegex, looseRegex, source }) {
    const filter = {
        status: { $in: ALLOWED_STATUSES },
        $or: [
            { clientPhone: { $in: phoneCandidates } },
            ...(legacyRegex ? [{ clientPhone: { $regex: legacyRegex } }] : []),
            ...(looseRegex ? [{ clientPhone: { $regex: looseRegex } }] : []),
        ],
    };

    if (sinceDedup) {
        filter.createdAt = { $gte: sinceDedup };
    }

    if (source) filter.source = source;

    return filter;
}

function parseWorkDays(raw) {
    if (!raw) return [];
    const normalized = String(raw)
        .replace(/[،，؛;|\t]/g, ',')
        .replace(/\s+/g, '')
        .replace(/[^1-7,]/g, '');

    return Array.from(new Set(normalized.split(',').filter(Boolean)));
}

/**
 * =========================
 * MAIN
 * =========================
 */
async function main(io) {
    try {
        const sheetId = process.env.SHEET_ID;
        const saKeyPath = process.env.SA_KEY_PATH;
        const minCountExcel = Number(process.env.MIN_COUNT_EXCEL || 1);

        if (!sheetId) throw new Error('❌ Missing SHEET_ID in .env');
        if (!saKeyPath) throw new Error('❌ Missing SA_KEY_PATH in .env');

        // Google Auth
        const auth = new GoogleAuth({
            keyFile: path.resolve(saKeyPath),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // 1) Determine range based on last lead n
        const [lastLead] = await LeadModel.aggregate([
            {
                $match: {
                    uniqueId: { $type: 'string', $regex: /^\d+$/ }, // faqat raqam stringlar
                },
            },
            {
                $addFields: {
                    uniqueIdNumeric: { $toLong: '$uniqueId' }, // katta qiymatlar uchun safer
                },
            },
            { $sort: { uniqueIdNumeric: -1 } },
            { $limit: 1 },
        ]);

        const nValue = lastLead?.uniqueIdNumeric || 0;
        console.log(`Last lead n: ${nValue}`);

        const lastRow = nValue > 500 ? nValue - 500 : 1;
        const nextStart = lastRow;
        const nextEnd = nextStart + 600;

        const range = `Asosiy!A${nextStart}:J${nextEnd}`;
        console.log(`Fetching sheet range: ${range}`);

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range,
        });

        const rows = response.data.values || [];
        console.log(`${rows.length} rows fetched from Google Sheets.`);
        if (!rows.length) return;

        // 2) Load operators (SAP)
        const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const operators = await b1Controller.execute(query);

        const allOperatorCodes = operators.map((op) => op.SlpCode);
        if (!allOperatorCodes.length) throw new Error('❌ No operators found in SAP.');

        // 3) Build leads from sheet rows
        const leads = [];
        let invalidPhoneCount = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = nextStart + i;
            const parsedTime = parseSheetDate(row[3]);
            const weekday = moment(parsedTime).isoWeekday().toString();

            let clientName = String(row[0] || '').trim();
            clientName = clientName.replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '').trim();

            if (!clientName) {
                const timestamp = moment().format('YYYYMMDD_HHmmss');
                clientName = `Mijoz_${timestamp}_${rowNumber}`;
            }

            const clientPhone = normalizePhone(row[1]);
            if (!clientPhone) {
                invalidPhoneCount++;
                continue;
            }

            const source = String(row[2] || '').trim();

            const uniqueCandidate = Number(row[6] || 0);
            const uniqueId = uniqueCandidate >= minCountExcel && row[6] ? String(row[6]).trim() : null;

            leads.push({
                n: rowNumber,
                uniqueId,
                clientName,
                clientPhone, // local 9 digits
                source,
                time: parsedTime,
                leadTime: row[3],
                weekday,
                cardCode: null,
                cardName: null,
            });
        }

        if (!leads.length) {
            console.log('⚠️ No valid leads after normalization.');
            return;
        }

        console.log({
            rowsFetched: rows.length,
            invalidPhoneCount,
            normalizedLeads: leads.length,
        });

        // 4) SAP match CardCode/CardName by phone (LIKE '%9digits')
        const phones = Array.from(new Set(leads.map((l) => l.clientPhone))).filter(Boolean);
        const existingMap = new Map();

        if (phones.length) {
            const chunks = chunk(phones, 300);

            for (const group of chunks) {
                const likeParts = group
                    .map((p) => `("Phone1" LIKE '%${p}' OR "Phone2" LIKE '%${p}')`)
                    .join(' OR ');

                const sapQuery = `
          SELECT "CardCode", "CardName", "Phone1", "Phone2"
          FROM ${DataRepositories.db}.OCRD
          WHERE ${likeParts}
        `;

                const existingRecords = await b1Controller.execute(sapQuery);

                for (const r of existingRecords) {
                    const phone1 = normalizePhone(r.Phone1);
                    const phone2 = normalizePhone(r.Phone2);

                    if (phone1) existingMap.set(phone1, { cardCode: r.CardCode, cardName: r.CardName });
                    if (phone2) existingMap.set(phone2, { cardCode: r.CardCode, cardName: r.CardName });
                }
            }
        }

        for (const lead of leads) {
            const match = existingMap.get(lead.clientPhone);
            if (match) {
                lead.cardCode = match.cardCode;
                lead.cardName = match.cardName;
            }
        }

        // 5) Dedup by uniqueId + phone (window)
        const uniqueLeads = [];
        const sinceDedup = new Date(Date.now() - DEDUP_WINDOW_MS);

        // batch duplicate uniqueId (inside current sheet chunk)
        const seenUniqueIdsInBatch = new Set();

        // prefetch existing uniqueIds from DB (fast)
        const batchUniqueIds = Array.from(new Set(leads.map((l) => l.uniqueId).filter(Boolean)));
        const existingUniqueIdDocs = batchUniqueIds.length
            ? await LeadModel.find({ uniqueId: { $in: batchUniqueIds } })
                .select('_id uniqueId')
                .lean()
            : [];

        const existingUniqueIdSet = new Set(existingUniqueIdDocs.map((d) => d.uniqueId));

        let duplicateByUniqueIdCount = 0;
        let duplicateByBatchUniqueIdCount = 0;
        let duplicateByPhoneCount = 0;
        let updatedNewTimeCount = 0;

        for (const lead of leads) {
            const local9 = normalizePhone(lead.clientPhone);
            if (!local9) continue;

            // 5.1 duplicate uniqueId inside current batch
            if (lead.uniqueId) {
                if (seenUniqueIdsInBatch.has(lead.uniqueId)) {
                    duplicateByBatchUniqueIdCount++;
                    continue;
                }
                seenUniqueIdsInBatch.add(lead.uniqueId);
            }

            // 5.2 duplicate uniqueId in DB
            if (lead.uniqueId && existingUniqueIdSet.has(lead.uniqueId)) {
                duplicateByUniqueIdCount++;

                try {
                    const existingByUniqueId = await LeadModel.findOne({ uniqueId: lead.uniqueId })
                        .select('_id')
                        .lean();

                    if (existingByUniqueId?._id) {
                        await LeadModel.updateOne(
                            { _id: existingByUniqueId._id },
                            { $set: { newTime: lead.time } }
                        );
                        updatedNewTimeCount++;
                    }
                } catch (e) {
                    console.warn(`⚠️ Failed to update newTime by uniqueId=${lead.uniqueId}:`, e?.message || e);
                }

                continue;
            }

            // 5.3 phone dedup (recent window)
            const { phoneCandidates, legacyRegex } = buildPhoneCandidates(local9);

            // looseRegex can overmatch; keep it disabled by default
            const dedupFilter = buildDedupFilter({
                sinceDedup,
                phoneCandidates,
                legacyRegex,
                looseRegex: null,
            });

            const existing = await LeadModel.findOne(dedupFilter).select('_id').lean();

            if (existing?._id) {
                duplicateByPhoneCount++;
                await LeadModel.updateOne(
                    { _id: existing._id },
                    {
                        $set: {
                            newTime: lead.time,
                        },
                    }
                );
                updatedNewTimeCount++;
                continue;
            }

            uniqueLeads.push(lead);
        }

        console.log({
            dedupWindowDays: DEDUP_WINDOW_DAYS,
            duplicateByBatchUniqueIdCount,
            duplicateByUniqueIdCount,
            duplicateByPhoneCount,
            updatedNewTimeCount,
            uniqueLeadsToInsert: uniqueLeads.length,
        });

        // 6) Operator assignment
        let lastAssignedIndex = 0;

        for (const lead of uniqueLeads) {
            const weekday = getWeekdaySafe(lead.time);

            if (lead.source?.trim() === 'Organika') {
                lead.operator = null;
                continue;
            }

            const availableOperators = operators.filter((op) => {
                const days = parseWorkDays(get(op, 'U_workDay', ''));
                return days.includes(weekday);
            });

            if (!availableOperators.length) {
                lead.operator = null;
                continue;
            }

            lead.operator = availableOperators[lastAssignedIndex % availableOperators.length].SlpCode;
            lastAssignedIndex++;
        }

        // 7) Insert (skip duplicate key errors, continue)
        const notInSap = uniqueLeads.filter((lead) => !lead.cardCode);

        let inserted = [];
        let skippedDuplicateInsertCount = 0;

        if (uniqueLeads.length > 0) {
            try {
                inserted = await LeadModel.insertMany(uniqueLeads, { ordered: false });
            } catch (err) {
                const writeErrors = err?.writeErrors || err?.errorResponse?.writeErrors || [];
                const nonDuplicateErrors = writeErrors.filter((e) => e.code !== 11000);

                if (nonDuplicateErrors.length > 0) {
                    console.error('❌ Non-duplicate insertMany errors:', nonDuplicateErrors.slice(0, 10));
                    throw err;
                }

                skippedDuplicateInsertCount = writeErrors.length;

                console.warn(`⚠️ Duplicate key errors skipped during insertMany: ${skippedDuplicateInsertCount}`);
                // inserted array may be incomplete/unreliable in bulk duplicate scenarios
                inserted = [];
            }
        }

        // 8) LeadChat events for inserted docs only
        if (inserted.length > 0) {
            const isSystem = true;
            const createdBy = 0;
            const createdByRole = 'System';

            const leadChatDocs = inserted.map((l) => ({
                leadId: l._id,
                type: 'event',
                action: 'lead_created',
                createdBy,
                createdByRole,
                isSystem,
                message: `Lead created (${l.source})`,
                changes: [
                    { field: 'source', from: null, to: l.source ?? null },
                    { field: 'clientPhone', from: null, to: l.clientPhone ?? null },
                    { field: 'operator', from: null, to: l.operator ?? null },
                ],
                statusFrom: null,
                statusTo: l.status ?? null,
                operatorFrom: null,
                operatorTo: l.operator ?? null,
            }));

            await LeadChat.insertMany(leadChatDocs, { ordered: false });
        }

        // 9) Logs / socket
        const approxInsertedCount =
            inserted.length > 0 ? inserted.length : Math.max(0, uniqueLeads.length - skippedDuplicateInsertCount);

        console.log(`📥 ${approxInsertedCount} new leads inserted into MongoDB.`);
        console.log(`🆕 SAP’da topilmagan yangi clientlar soni: ${notInSap.length}`);
        if (skippedDuplicateInsertCount > 0) {
            console.log(`⚠️ Skipped duplicate inserts (E11000): ${skippedDuplicateInsertCount}`);
        }

        if (io && approxInsertedCount > 0) {
            io.emit('new_leads_summary', {
                total: approxInsertedCount,
                notInSap: notInSap.length,
            });
            console.log('📡 Socket broadcast: new_leads_summary sent to all clients');
        }

        const operatorStats = {};
        for (const lead of uniqueLeads) {
            const key = lead.operator ?? 'null';
            operatorStats[key] = (operatorStats[key] || 0) + 1;
        }
        console.table(operatorStats);

        console.log('✅ Lead sync completed (dedup + operator assignment).');
    } catch (err) {
        console.error(err);
        console.error('❌ Error in Google Sheet sync:', err?.message || err);
    }
}

module.exports = { main };