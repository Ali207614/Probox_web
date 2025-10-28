const express = require('express');
const moment = require('moment');
const get = require('lodash/get');
const path = require('path');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const LeadModel  = require('../models/lead-model');
const DataRepositories = require("../repositories/dataRepositories");
const b1Controller = require('../controllers/b1HANA');
const router = express.Router();

// === Auth ===
const AUTH_USER = process.env.GS_WEBHOOK_USER || 'sheetbot';
const AUTH_PASS = process.env.GS_WEBHOOK_PASS || 'supersecret';

/**
 * Basic Auth middleware
 */
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

/**
 * === Utility: parseSheetDate ===
 */
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

/**
 * === Main webhook ===
 */
router.post('/webhook', basicAuth, async (req, res) => {
    try {
        const { sheetName } = req.body;
        if (!sheetName || sheetName !== 'Asosiy') {
            return res.status(200).json({ message: `Ignored — sheet "${sheetName}" is not Asosiy.` });
        }

        // === 1️⃣ MongoDB’dan oxirgi rowNumber olish
        const lastLead = await LeadModel.findOne({}, { n: 1 }).sort({ n: -1 }).lean();
        const lastRow = lastLead?.n || 2;
        const nextStart = lastRow + 1;
        const nextEnd = nextStart + 5;

        console.log(`🔍 Checking new rows from ${nextStart} to ${nextEnd}`);

        const sheetId = process.env.SHEET_ID;
        const saKeyPath = process.env.SA_KEY_PATH || './sa.json';

        const auth = new GoogleAuth({
            keyFile: path.resolve(saKeyPath),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });

        const range = `Asosiy!A${nextStart}:J${nextEnd}`;
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range,
        });

        const rows = response.data.values || [];
        if (!rows.length) {
            console.log('⚠️ No new rows found.');
            return res.status(200).json({ message: 'No new rows detected.' });
        }

        const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const data = await b1Controller.execute(query);
        const operatorIndex = {};

        let counter = 1;
        const leads = rows.map((row, i) => {
            const rowNumber = nextStart + i;
            const parsedTime = parseSheetDate(row[3]);
            const weekday = moment(parsedTime).isoWeekday().toString();

            const availableOperators = data.filter((item) =>
                get(item, 'U_workDay', '').split(',').includes(weekday)
            );

            let operator = null;
            if (availableOperators.length > 0) {
                const randomIndex = Math.floor(Math.random() * availableOperators.length);
                operator = availableOperators[randomIndex];
            }

            let clientName = row[0]?.trim() || '';
            clientName = clientName.replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '').trim();
            if (!clientName) clientName = `Mijoz_${counter++}`;

            let clientPhone = (row[1] || '').replace(/\D/g, '').slice(0, 12);

            return {
                n: rowNumber,
                clientName,
                clientPhone,
                source: row[2]?.trim() || '',
                time: parsedTime,
                operator: operator?.SlpCode || null,
            };
        }).filter(lead => lead.clientPhone);

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
