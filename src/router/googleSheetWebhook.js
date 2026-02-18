'use strict';

const express = require('express');
const path = require('path');
const moment = require('moment');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { get } = require('lodash');

require('dotenv').config();

const LeadModel = require('../models/lead-model');
const LeadChat = require('../models/lead-chat-model');
const DataRepositories = require('../repositories/dataRepositories');
const b1Controller = require('../controllers/b1HANA');
const { ALLOWED_STATUSES } = require('../config');

const router = express.Router();

/**
 * =========================
 * Env / constants
 * =========================
 */
const AUTH_USER = process.env.GS_WEBHOOK_USER || 'sheetbot';
const AUTH_PASS = process.env.GS_WEBHOOK_PASS || 'supersecret';
const SHEET_ID = process.env.SHEET_ID;
const SA_KEY_PATH = process.env.SA_KEY_PATH || './sa.json';

const TZ_OFFSET_MIN = 5 * 60; // +05:00
const DEDUP_WINDOW_DAYS = Number(process.env.DEDUP_WINDOW_DAYS || 2);
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const MIN_COUNT_EXCEL = Number(process.env.MIN_COUNT_EXCEL || 1);

/**
 * =========================
 * Helpers
 * =========================
 */
function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Basic ')) {
        return res.status(401).json({ message: 'Missing or invalid Authorization header' });
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (username !== AUTH_USER || password !== AUTH_PASS) {
        return res.status(403).json({ message: 'Invalid credentials' });
    }

    return next();
}

function nowTz() {
    return moment().utcOffset(TZ_OFFSET_MIN);
}

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

function normalizePhone(input) {
    if (!input) return null;

    let digits = digitsOnly(input);

    // remove +998 prefix
    if (digits.startsWith('998')) digits = digits.slice(3);

    // remove leading 0
    if (digits.startsWith('0')) digits = digits.slice(1);

    // local format: 9 digits
    if (digits.length !== 9) return null;

    return digits;
}

function parseSheetDate(value) {
    // fallback: now (+05:00)
    if (value == null || value === '') return nowTz().toDate();

    // normalize string (sheet sometimes sends weird spaces/slashes)
    const cleaned = String(value)
        .trim()
        .replace(/[\/\\]/g, '.')     // 01/02/2026 -> 01.02.2026
        .replace(/\u00A0/g, ' ')     // no-break space
        .replace(/\u200B/g, '')      // zero-width space
        .replace(/\s+/g, ' ');

    // ✅ Excel serial number (e.g. 45231)
    if (!isNaN(cleaned) && cleaned !== '') {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const date = new Date(excelEpoch.getTime() + Number(cleaned) * 86400000);
        return moment(date).utcOffset(TZ_OFFSET_MIN).toDate();
    }

    // ✅ Supported formats from sheet
    const formats = ['DD.MM.YYYY HH:mm:ss', 'DD.MM.YYYY HH:mm', 'DD.MM.YYYY'];

    // strict parse first
    let parsed = moment(cleaned, formats, true);

    // fallback non-strict
    if (!parsed.isValid()) parsed = moment(cleaned, formats);

    if (!parsed.isValid()) return nowTz().toDate();

    // If only date provided: attach current time (so it doesn't become 00:00:00)
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(cleaned)) {
        const n = nowTz();
        parsed = parsed.set({
            hour: n.hour(),
            minute: n.minute(),
            second: n.second(),
            millisecond: 0,
        });
    }

    // ✅ Force timezone +05:00 WITHOUT rebuilding a string (no Moment deprecation warning)
    return parsed.utcOffset(TZ_OFFSET_MIN, true).toDate();
}


function getWeekdaySafe(dateLike) {
    let m = moment(dateLike);
    if (!m.isValid()) m = moment();

    // sizda bu qoida bor: 19:00 dan keyin ertangi kun operator schedule
    if (m.hour() >= 19) return m.add(1, 'day').isoWeekday().toString();

    return m.isoWeekday().toString();
}

function parseWorkDays(raw) {
    if (!raw) return [];
    const normalized = String(raw)
        .replace(/[،，؛;|\t]/g, ',')
        .replace(/\s+/g, '')
        .replace(/[^1-7,]/g, '');

    return Array.from(new Set(normalized.split(',').filter(Boolean)));
}

async function getOperatorBalance(operators) {
    const startOfDay = moment().startOf('day').toDate();
    const endOfDay = moment().endOf('day').toDate();

    const todayLeads = await LeadModel.find({
        operator: { $in: operators.map((o) => o.SlpCode) },
        createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).lean();

    const balance = {};
    operators.forEach((op) => (balance[op.SlpCode] = 0));

    for (const lead of todayLeads) {
        if (balance[lead.operator] !== undefined) balance[lead.operator]++;
    }

    return balance;
}

let lastAssignedIndex = 0;

function pickLeastLoadedOperator(availableOperators, balance) {
    if (!availableOperators.length) return null;

    const pool = availableOperators.filter((op) => balance[op.SlpCode] !== undefined);
    if (!pool.length) return null;

    const minCount = Math.min(...pool.map((op) => balance[op.SlpCode] || 0));
    const leastLoaded = pool.filter((op) => (balance[op.SlpCode] || 0) === minCount);

    const chosen = leastLoaded[lastAssignedIndex % leastLoaded.length];
    lastAssignedIndex++;

    balance[chosen.SlpCode] = (balance[chosen.SlpCode] || 0) + 1;

    return chosen;
}

/**
 * Phone canonicalization for dedup:
 * - local 9 digits -> 998 + local9
 * - full 998XXXXXXXXX -> keep first 12 digits
 */
function canonicalizePhone(raw) {
    const d = digitsOnly(raw);
    if (!d) return null;

    if (/^\d{9}$/.test(d)) return `998${d}`;
    if (d.startsWith('998') && d.length >= 12) return d.slice(0, 12);

    return d;
}

function buildPhoneCandidates(raw) {
    const d = digitsOnly(raw);
    const canonical = canonicalizePhone(raw);
    const local9 = d.length >= 9 ? d.slice(-9) : null;

    const candidates = [];
    if (canonical) candidates.push(canonical);
    if (local9 && local9 !== canonical) candidates.push(local9);

    // legacy data: phone may end with local9
    const legacyRegex = local9 ? new RegExp(`${local9}$`) : null;

    return { canonical, local9, candidates, legacyRegex };
}

function buildDedupFilter({ sinceDedup, phoneCandidates, legacyRegex, looseRegex, source }) {
    const filter = {
        status: { $in: ALLOWED_STATUSES },
        $or: [
            { clientPhone: { $in: phoneCandidates } },
            ...(legacyRegex ? [{ clientPhone: { $regex: legacyRegex } }] : []),
            ...(looseRegex ? [{ clientPhone: { $regex: looseRegex } }] : []),
        ],
    };

    if (source) filter.source = source;
    return filter;
}


function buildLoosePhoneRegexFromLocal9(local9) {
    if (!local9) return null;
    const pat = local9.split('').join('\\D*');
    return new RegExp(pat);
}

/**
 * =========================
 * Route
 * =========================
 */
router.post('/webhook', basicAuth, async (req, res) => {
    try {
        const { sheetName } = req.body;

        if (sheetName !== 'Asosiy') {
            return res.status(200).json({ message: `Ignored — sheet "${sheetName}" is not Asosiy.` });
        }

        /**
         * 1) Find last lead "n" (numeric)
         */
        const [lastLead] = await LeadModel.aggregate([
            {
                $match: {
                    $or: [
                        { n: { $type: 'int' } },
                        { n: { $type: 'long' } },
                        { n: { $type: 'double' } },
                        { n: { $type: 'string', $regex: /^\d+$/ } },
                    ],
                },
            },
            {
                $addFields: {
                    nNumeric: {
                        $cond: [{ $eq: [{ $type: '$n' }, 'string'] }, { $toInt: '$n' }, '$n'],
                    },
                },
            },
            { $sort: { nNumeric: -1 } },
            { $limit: 1 },
        ]);

        const nValue = lastLead?.nNumeric || 0;
        const nextStart = nValue > 200 ? nValue - 200 : 2;
        const nextEnd = nextStart + 400;

        console.log(`🔍 Checking new rows from ${nextStart} to ${nextEnd}`);

        /**
         * 2) Read Google Sheets
         */
        const auth = new GoogleAuth({
            keyFile: path.resolve(SA_KEY_PATH),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const range = `Asosiy!A${nextStart}:J${nextEnd}`;

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range,
        });

        const rows = response.data.values || [];
        if (!rows.length) {
            console.log('⚠️ No new rows found.');
            return res.status(200).json({ message: 'No new rows detected.' });
        }


        const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const operators = await b1Controller.execute(query);
        const operatorBalance = await getOperatorBalance(operators);


        const leads = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = nextStart + i;

            const parsedTime = parseSheetDate(row[3]);
            const weekday = getWeekdaySafe(parsedTime);
            const source = String(row[2] || '').trim();

            let operator = null;

            if (source !== 'Organika') {
                const availableOperators = operators.filter((item) => {
                    const days = parseWorkDays(get(item, 'U_workDay', ''));
                    return days.includes(weekday);
                });

                operator = pickLeastLoadedOperator(availableOperators, operatorBalance);
            }

            let clientName = String(row[0] || '')
                .trim()
                .replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '');

            if (!clientName) clientName = `Mijoz_${moment().format('YYYYMMDD_HHmmss')}_${rowNumber}`;
            if (clientName.length > 30) clientName = clientName.slice(0, 30).trim() + '...';

            const clientPhone = normalizePhone(row[1]);
            if (!clientPhone) continue;

            const uniqueCandidate = Number(row[6] || 0);

            leads.push({
                n: rowNumber,
                clientName,
                clientPhone, // local 9 digits
                source,
                uniqueId: uniqueCandidate >= MIN_COUNT_EXCEL ? String(row[6]) : null,
                time: parsedTime,
                leadTime: row[3],
                operator: operator?.SlpCode || null,
            });
        }

        if (!leads.length) {
            console.log('⚠️ No valid leads after normalization.');
            return res.status(200).json({ message: 'No valid leads.' });
        }

        /**
         * 5) SAP: match phone -> CardCode/CardName
         */
        const phones = leads.map((l) => l.clientPhone).filter(Boolean);
        const existingMap = new Map();

        if (phones.length) {
            const phoneList = phones.map((p) => `'${p}'`).join(', ');
            const sapQuery = `
        SELECT "CardCode", "CardName", "Phone1", "Phone2"
        FROM ${DataRepositories.db}.OCRD
        WHERE "Phone1" IN (${phoneList}) OR "Phone2" IN (${phoneList})
      `;

            const existingRecords = await b1Controller.execute(sapQuery);

            for (const r of existingRecords) {
                const phone = digitsOnly(r.Phone1 || r.Phone2 || '');
                if (phone) existingMap.set(phone, { CardCode: r.CardCode, CardName: r.CardName });
            }
        }

        for (const lead of leads) {
            const cleanPhone = digitsOnly(lead.clientPhone);
            const found = existingMap.get(cleanPhone);

            if (found) {
                lead.cardCode = found.CardCode;
                lead.cardName = found.CardName;
            }
        }

        /**
         * 6) Insert leads with dedup (phone-based)
         */
        const inserted = [];
        const eventDocs = [];

        const sinceDedup = new Date(Date.now() - DEDUP_WINDOW_MS);

        for (const lead of leads) {
            try {
                const normalizedPhone = normalizePhone(lead.clientPhone);
                if (!normalizedPhone) continue;

                const { candidates: phoneCandidates, legacyRegex ,local9} =
                    buildPhoneCandidates(normalizedPhone);

                const looseRegex = buildLoosePhoneRegexFromLocal9(local9);

                const dedupFilter = buildDedupFilter({
                    sinceDedup,
                    phoneCandidates,
                    legacyRegex,
                    looseRegex
                    // source: lead.source, // agar dedup source bo‘yicha ham bo‘lsin desangiz oching
                });

                const existing = await LeadModel.findOne(dedupFilter).select('_id').lean();

                if (existing) {
                    await LeadModel.updateOne(
                        { _id: existing._id },
                        {
                            $set: {
                                newTime: lead.time,          // parsedTime
                            },
                        },
                    );

                    continue;
                }


                lead.createdAt = new Date();
                const createdLead = await LeadModel.create(lead);
                inserted.push(createdLead);

                const createdBy = Number(req.user?.id ?? req.user?.U_id ?? req.user?.userId ?? 0);
                const createdByRole = req.user?.U_role ?? req.user?.role ?? null;

                eventDocs.push({
                    leadId: createdLead._id,
                    type: 'event',
                    action: 'lead_created',

                    createdBy,
                    createdByRole,
                    isSystem: false,

                    message: `Lead created (${createdLead.source})`,
                    changes: [
                        { field: 'source', from: null, to: createdLead.source ?? null },
                        { field: 'clientPhone', from: null, to: createdLead.clientPhone ?? null },
                        { field: 'operator', from: null, to: createdLead.operator ?? null },
                    ],
                    statusFrom: null,
                    statusTo: createdLead.status ?? null,
                    operatorFrom: null,
                    operatorTo: createdLead.operator ?? null,
                });
            } catch (err) {
                if (err?.code === 11000) console.warn('Duplicate skipped:', lead.n);
                else throw err;
            }
        }

        if (eventDocs.length) {
            await LeadChat.insertMany(eventDocs);
        }

        /**
         * 7) socket emit
         */
        const io = req.app.get('io');
        if (io && inserted.length > 0) {
            io.emit('new_leads', inserted); // array
        }

        console.log(`📥 ${inserted.length} new rows inserted successfully.`);
        return res.status(200).json({ message: `Inserted ${inserted.length} new rows.` });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
