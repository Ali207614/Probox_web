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
    if (!value) return null;
    if (!isNaN(value)) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        return new Date(excelEpoch.getTime() + value * 86400000);
    }
    const str = String(value).trim().replace(/\//g, '.');
    const parsed = moment(str, ['DD.MM.YYYY HH:mm:ss', 'DD.MM.YYYY', 'YYYY-MM-DDTHH:mm:ss.SSSZ'], true);
    return parsed.isValid() ? parsed.toDate() : null;
}

function normalizePhone(input) {
    if (!input) return null;
    let digits = String(input).replace(/\D/g, '');
    if (digits.startsWith('998') && digits.length > 9) digits = digits.slice(3);
    if (digits.length === 10 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length !== 9) return null;
    return digits;
}

async function getOperatorBalance(operators) {
    const lastLeads = await LeadModel.find({ operator: { $ne: null } })
        .sort({ _id: -1 })
        .limit(50)
        .lean();

    const balance = {};
    for (const op of operators) {
        balance[op.SlpCode] = 0;
    }

    for (const lead of lastLeads) {
        if (balance[lead.operator] !== undefined) {
            balance[lead.operator]++;
        }
    }

    return balance;
}

function pickLeastLoadedOperator(availableOperators, balance) {
    if (!availableOperators.length) return null;

    // Filter: faqat balansda mavjud operatorlarni olish
    const filtered = availableOperators.filter(op => balance[op.SlpCode] !== undefined);
    if (!filtered.length) return availableOperators[0];

    // Eng kam yuklangan operatorni topish
    filtered.sort((a, b) => balance[a.SlpCode] - balance[b.SlpCode]);
    const chosen = filtered[0];

    // Balansni yangilash
    balance[chosen.SlpCode]++;
    return chosen;
}

router.post('/webhook', basicAuth, async (req, res) => {
    try {
        const { sheetName } = req.body;
        if (!sheetName || sheetName !== 'Asosiy') {
            return res.status(200).json({ message: `Ignored — sheet "${sheetName}" is not Asosiy.` });
        }

        const lastLead = await LeadModel.findOne({}, { n: 1 }).sort({ n: -1 }).lean();
        const lastRow = lastLead?.n || 2;
        const nextStart = lastRow;
        const nextEnd = nextStart + 10;

        console.log(`🔍 Checking new rows from ${nextStart} to ${nextEnd}`);

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

        const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const operators = await b1Controller.execute(query);
        const operatorBalance = await getOperatorBalance(operators);

        const leads = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = nextStart + i;
            const parsedTime = parseSheetDate(row[3]);
            const weekday = moment(parsedTime).isoWeekday().toString();

            const availableOperators = operators.filter((item) =>
                get(item, 'U_workDay', '').split(',').includes(weekday)
            );

            const operator = pickLeastLoadedOperator(availableOperators, operatorBalance);

            let clientName = row[0]?.trim() || '';
            clientName = clientName.replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '').trim();

            if (!clientName) {
                const timestamp = moment().format('YYYYMMDD_HHmmss');
                clientName = `Mijoz_${timestamp}_${rowNumber}`;
            }

            const clientPhone = normalizePhone(row[1]);
            if (!clientPhone) continue;

            leads.push({
                n: rowNumber,
                clientName,
                clientPhone,
                source: row[2]?.trim() || '',
                time: parsedTime,
                operator: operator?.SlpCode || null,
            });
        }

        if (!leads.length) {
            console.log('⚠️ No valid leads after normalization.');
            return res.status(200).json({ message: 'No valid leads.' });
        }

        const uniqueLeads = [];
        for (const lead of leads) {
            const exists = await LeadModel.exists({
                clientName: lead.clientName,
                clientPhone: lead.clientPhone,
                source: lead.source,
            });
            if (!exists) uniqueLeads.push(lead);
        }

        if (!uniqueLeads.length) {
            console.log('✅ No unique new leads found.');
            return res.status(200).json({ message: 'No unique new leads.' });
        }

        const phones = uniqueLeads.map((l) => l.clientPhone).filter(Boolean);
        let existingMap = new Map();

        if (phones.length > 0) {
            const phoneList = phones.map((p) => `'${p}'`).join(', ');
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

        for (const lead of uniqueLeads) {
            const cleanPhone = lead.clientPhone.replace(/\D/g, '');
            const found = existingMap.get(cleanPhone);

            if (found) {
                lead.cardCode = found.CardCode;
                lead.cardName = found.CardName;
                console.log(`🔁 Existing BP found: ${found.CardCode} (${found.CardName})`);
            } else {
                const newCode = await b1ServiceLayer.createBusinessPartner({
                    Phone1: cleanPhone,
                    CardName: lead.clientName,
                });
                if (newCode) {
                    lead.cardCode = newCode.CardCode;
                    lead.cardName = newCode.CardName;
                    console.log(`🆕 Created new BP: ${newCode.CardCode}`);
                } else {
                    console.log(`⚠️ Failed to create BP for ${lead.clientName}`);
                }
            }
        }

        const inserted = await LeadModel.insertMany(uniqueLeads);

        const io = req.app.get('io');
        if (io && inserted.length > 0) {
            io.emit('new_leads', inserted);
            console.log('📡 Socket broadcast: new_leads sent to all clients');
        }

        console.log(`📥 ${inserted.length} new rows inserted successfully.`);
        return res.status(200).json({ message: `Inserted ${inserted.length} new rows.` });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
