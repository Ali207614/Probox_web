const express = require('express');
const path = require('path');
const moment = require('moment');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { get } = require('lodash');
const LeadModel = require('../models/lead-model');
const DataRepositories = require('../repositories/dataRepositories');
const b1Controller = require('../controllers/b1HANA');
const b1ServiceLayer = require('../controllers/b1SL');
const router = express.Router();

const AUTH_USER = process.env.GS_WEBHOOK_USER || 'sheetbot';
const AUTH_PASS = process.env.GS_WEBHOOK_PASS || 'supersecret';
const SHEET_ID = process.env.SHEET_ID;
const SA_KEY_PATH = process.env.SA_KEY_PATH || './sa.json';

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
    next();
}

function parseSheetDate(value) {
    if (!value) {
        return moment().utcOffset(5).toDate();
    }

    if (!isNaN(value)) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const date = new Date(excelEpoch.getTime() + value * 86400000);
        return moment(date).utcOffset(5).toDate();
    }

    const str = String(value)
        .trim()
        .replace(/[\/\\]/g, '.')
        .replace(/\u00A0/g, ' ')   // no-break space
        .replace(/\u200B/g, '')    // zero width
        .replace(/\s+/g, ' ');

    let parsed = moment(str, [
        'DD.MM.YYYY HH:mm:ss',
        'DD.MM.YYYY HH:mm',
        'DD.MM.YYYY'
    ], true);

    if (parsed.isValid() && /^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
        const now = moment().utcOffset(5);
        parsed = parsed.set({
            hour: now.hour(),
            minute: now.minute(),
            second: now.second()
        });
    }

    if (!parsed.isValid()) {
        return moment().utcOffset(5).toDate();
    }

    parsed = moment(parsed.format("YYYY-MM-DD HH:mm:ss") + " +05:00");

    return parsed.toDate();
}


function normalizePhone(input) {
    if (!input) return null;
    let digits = String(input).replace(/\D/g, '');
    if (digits.startsWith('998')) digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length !== 9) return null;
    return digits;
}

function getWeekdaySafe(dateLike) {
    let m = moment(dateLike);

    if (!m.isValid()) {
        m = moment();
    }

    if (m.hour() >= 19) {
        return m.add(1, 'day').isoWeekday().toString();
    }

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
        operator: { $in: operators.map(o => o.SlpCode) },
        createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).lean();

    const balance = {};
    operators.forEach(op => (balance[op.SlpCode] = 0));
    todayLeads.forEach(lead => {
        if (balance[lead.operator] !== undefined) balance[lead.operator]++;
    });

    return balance;
}

let lastAssignedIndex = 0;

function pickLeastLoadedOperator(availableOperators, balance) {
    if (!availableOperators.length) return null;

    const pool = availableOperators.filter(op => balance[op.SlpCode] !== undefined);
    if (!pool.length) return null;

    const minCount = Math.min(...pool.map(op => balance[op.SlpCode] || 0));
    const leastLoaded = pool.filter(op => (balance[op.SlpCode] || 0) === minCount);

    const chosen = leastLoaded[lastAssignedIndex % leastLoaded.length];
    lastAssignedIndex++;

    balance[chosen.SlpCode] = (balance[chosen.SlpCode] || 0) + 1;
    return chosen;
}

router.post('/webhook', basicAuth, async (req, res) => {
    try {
        const { sheetName } = req.body;
        if (!sheetName || sheetName !== 'Asosiy') {
            return res.status(200).json({ message: `Ignored — sheet "${sheetName}" is not Asosiy.` });
        }

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
        const nextStart = nValue > 500 ? nValue - 500 : 2;
        const nextEnd = nextStart + 800;
        console.log(`🔍 Checking new rows from ${nextStart} to ${nextEnd}`);

        // === Google Sheets
        const auth = new GoogleAuth({
            keyFile: path.resolve(SA_KEY_PATH),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const range = `Asosiy!A${nextStart}:J${nextEnd}`;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
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
            const source = (row[2] || '').trim();

            let operator = null;
            if (source !== 'Organika') {
                const availableOperators = operators.filter(item => {
                    const days = parseWorkDays(get(item, 'U_workDay', ''));
                    return days.includes(weekday);
                });

                operator = pickLeastLoadedOperator(availableOperators, operatorBalance);
            }

            let clientName = (row[0] || '').trim().replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '');
            if (!clientName) clientName = `Mijoz_${moment().format('YYYYMMDD_HHmmss')}_${rowNumber}`;
            if (clientName.length > 30) clientName = clientName.slice(0, 30).trim() + '...';

            const clientPhone = normalizePhone(row[1]);
            if (!clientPhone) continue;

            leads.push({
                n: rowNumber,
                clientName,
                clientPhone,
                source,
                time: parsedTime,
                leadTime:row[3],
                operator: operator?.SlpCode || null,
            });
        }

        if (!leads.length) {
            console.log('⚠️ No valid leads after normalization.');
            return res.status(200).json({ message: 'No valid leads.' });
        }

        const phones = leads.map(l => l.clientPhone).filter(Boolean);
        const existingMap = new Map();

        if (phones.length > 0) {
            const phoneList = phones.map(p => `'${p}'`).join(', ');
            const sapQuery = `
        SELECT "CardCode", "CardName", "Phone1", "Phone2"
        FROM ${DataRepositories.db}.OCRD
        WHERE "Phone1" IN (${phoneList}) OR "Phone2" IN (${phoneList})
      `;
            const existingRecords = await b1Controller.execute(sapQuery);
            for (const r of existingRecords) {
                const phone = (r.Phone1 || r.Phone2 || '').replace(/\D/g, '');
                existingMap.set(phone, { CardCode: r.CardCode, CardName: r.CardName });
            }
        }

        for (const lead of leads) {
            const cleanPhone = lead.clientPhone.replace(/\D/g, '');
            const found = existingMap.get(cleanPhone);

            if (found) {
                lead.cardCode = found.CardCode;
                lead.cardName = found.CardName;
            } else {
                // const newBP = await b1ServiceLayer.createBusinessPartner({
                //     Phone1: cleanPhone,
                //     CardName: lead.clientName,
                // });
                // if (newBP?.CardCode) {
                //     lead.cardCode = newBP.CardCode;
                //     lead.cardName = newBP.CardName;
                // }
            }
        }

        const inserted = [];

        for (const lead of leads) {
            try {
                const normalizedPhone = normalizePhone(lead.clientPhone);
                if (!normalizedPhone) continue;

                const start = moment().utcOffset(5).startOf('day').subtract(2, 'days');
                const end = moment().utcOffset(5).endOf('day');

                const existing = await LeadModel.findOne({
                    clientPhone: { $in: [normalizedPhone, "998" + normalizedPhone] },
                    source: lead.source,
                    createdAt: { $gte: start.toDate(), $lte: end.toDate() }
                });

                if (existing) continue;

                lead.createdAt = new Date();
                await LeadModel.create(lead);

                inserted.push(lead);

            } catch (err) {
                if (err.code === 11000) console.warn("Duplicate skipped:", lead.n);
                else throw err;
            }
        }



        const io = req.app.get('io');
        if (io && inserted.length > 0) io.emit('new_leads', {...inserted, SlpCode: inserted.operator});

        console.log(`📥 ${inserted.length} new rows inserted successfully.`);
        return res.status(200).json({ message: `Inserted ${inserted.length} new rows.` });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
