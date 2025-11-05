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

// ==================== AUTH ====================
function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
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
    // 1️⃣ Agar qiymat yo‘q bo‘lsa — bugungi sanani qaytaradi
    if (!value) {
        return moment().utcOffset(5).toDate();
    }

    // 2️⃣ Excel serial date (raqam) bo‘lsa
    if (!isNaN(value)) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        return new Date(excelEpoch.getTime() + value * 86400000);
    }

    // 3️⃣ String formatni tozalash
    const str = String(value).trim().replace(/[\/\\]/g, '.');

    // 4️⃣ Ehtimoliy formatlar bilan parse qilish
    let parsed = moment(str, ['DD.MM.YYYY HH:mm:ss', 'DD.MM.YYYY HH:mm', 'DD.MM.YYYY'], true);

    // 5️⃣ Agar faqat sana kiritilgan bo‘lsa, hozirgi vaqtni qo‘shamiz
    if (parsed.isValid() && /^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
        const now = moment();
        parsed.set({
            hour: now.hour(),
            minute: now.minute(),
            second: now.second(),
        });
    }

    // 6️⃣ Agar format yaroqsiz bo‘lsa, bugungi sanani qaytaramiz
    if (!parsed.isValid()) {
        return moment().utcOffset(5).toDate();
    }

    // 7️⃣ Yaroqli bo‘lsa — Toshkent vaqti bilan qaytaramiz
    return parsed.utcOffset(5).toDate();
}

function normalizePhone(input) {
    if (!input) return null;
    let digits = String(input).replace(/\D/g, '');
    if (digits.startsWith('998') && digits.length > 9) digits = digits.slice(3);
    if (digits.length === 10 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length !== 9) return null;
    return digits;
}

function getWeekdaySafe(dateLike) {
    const m = moment(dateLike);
    return m.isValid() ? m.isoWeekday().toString() : moment().isoWeekday().toString();
}

function parseWorkDays(raw) {
    if (!raw) return [];
    const normalized = String(raw)
        .replace(/[،，؛;|\t]/g, ',')
        .replace(/\s+/g, '')
        .replace(/[^1-7,]/g, '');
    return Array.from(new Set(normalized.split(',').filter(Boolean)));
}

// ==================== OPERATOR BALANCE ====================
async function getOperatorBalance(operators) {
    const today = moment().startOf('day').toDate();

    const todayLeads = await LeadModel.find({
        operator: { $ne: null },
        createdAt: { $gte: today },
    }).lean();

    const balance = {};
    for (const op of operators) balance[op.SlpCode] = 0;

    for (const lead of todayLeads) {
        if (balance[lead.operator] !== undefined) balance[lead.operator]++;
    }

    return balance;
}

function pickLeastLoadedOperator(availableOperators, balance) {
    if (!availableOperators.length) return null;

    const filtered = availableOperators.filter(op => balance[op.SlpCode] !== undefined);
    const pool = filtered.length ? filtered : availableOperators;

    pool.sort((a, b) => (balance[a.SlpCode] ?? 0) - (balance[b.SlpCode] ?? 0));

    const chosen = pool[0];
    balance[chosen.SlpCode] = (balance[chosen.SlpCode] ?? 0) + 1;
    return chosen;
}

// ==================== MAIN ROUTE ====================
router.post('/webhook', basicAuth, async (req, res) => {
    try {
        const { sheetName } = req.body;
        if (!sheetName || sheetName !== 'Asosiy') {
            return res.status(200).json({ message: `Ignored — sheet "${sheetName}" is not Asosiy.` });
        }

        const lastLead = await LeadModel.findOne({}, { n: 1 }).sort({ n: -1 }).lean();
        const lastRow = (lastLead?.n > 51 ? lastLead.n - 50 : 2) || 2;
        const nextStart = lastRow;
        const nextEnd = nextStart + 100;

        console.log(`🔍 Checking new rows from ${nextStart} to ${nextEnd}`);

        // === Google Sheets
        const sheetId = process.env.SHEET_ID;
        const saKeyPath = process.env.SA_KEY_PATH || './sa.json';
        const auth = new GoogleAuth({
            keyFile: path.resolve(saKeyPath),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const range = `Asosiy!A${nextStart}:J${nextEnd}`;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
        const rows = response.data.values || [];
        if (!rows.length) {
            console.log('⚠️ No new rows found.');
            return res.status(200).json({ message: 'No new rows detected.' });
        }

        // === Operatorlar
        const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const operators = await b1Controller.execute(query);
        const operatorBalance = await getOperatorBalance(operators);

        const leads = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = nextStart + i;
            const parsedTime =  parseSheetDate(row[3]);

            const weekday = getWeekdaySafe(parsedTime);
            console.log(weekday ,' bu hafta kuni')
            const source = (row[2] || '').trim();

            let operator = null;
            if (source !== 'Organika') {
                const availableOperators = operators.filter(item => {
                    const days = parseWorkDays(get(item, 'U_workDay', ''));
                    return days.includes(weekday);
                });
                console.log(availableOperators.map(el => {
                    return {SlpName:el.SlpName , SlpCode: el.SlpCode , U_workDay: el.U_workDay}
                }) ,' bu bolingan operatorlar')
                operator = pickLeastLoadedOperator(availableOperators, operatorBalance);
            }

            let clientName = (row[0] || '').trim().replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '').trim();
            if (!clientName) {
                const timestamp = moment().format('YYYYMMDD_HHmmss');
                clientName = `Mijoz_${timestamp}_${rowNumber}`;
            }

            if (clientName.length > 30) {
                clientName = clientName.slice(0, 30).trim() + '...';
            }

            const clientPhone = normalizePhone(row[1]);
            if (!clientPhone) continue;

            leads.push({
                n: rowNumber,
                clientName,
                clientPhone,
                source,
                time: parsedTime,
                operator: operator?.SlpCode || null,
            });
        }

        if (!leads.length) {
            console.log('⚠️ No valid leads after normalization.');
            return res.status(200).json({ message: 'No valid leads.' });
        }

        // === SAP bilan tekshirish
        const phones = leads.map(l => l.clientPhone).filter(Boolean);
        let existingMap = new Map();

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
                const newCode = await b1ServiceLayer.createBusinessPartner({
                    Phone1: cleanPhone,
                    CardName: lead.clientName,
                });

                if (newCode?.CardCode) {
                    lead.cardCode = newCode.CardCode;
                    lead.cardName = newCode.CardName;
                }
            }
        }

        const inserted = [];

        for (const lead of leads) {
            try {
                const doc = await LeadModel.findOneAndUpdate(
                    { n: lead.n },
                    { $setOnInsert: lead },
                    { upsert: true, new: false }
                );
                if (!doc) inserted.push(lead);
            } catch (err) {
                if (err.code === 11000) {
                    console.warn('Duplicate skipped:', lead.n);
                } else {
                    throw err;
                }
            }
        }

        const io = req.app.get('io');
        if (io && inserted.length > 0) io.emit('new_leads', inserted);

        console.log(`📥 ${inserted.length} new rows inserted successfully.`);
        return res.status(200).json({ message: `Inserted ${inserted.length} new rows.` });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
