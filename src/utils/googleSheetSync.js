const path = require('path');
const moment = require('moment');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { get } = require('lodash');
const LeadModel = require('../models/lead-model');
const DataRepositories = require('../repositories/dataRepositories');
const b1Controller = require('../controllers/b1HANA');
require('dotenv').config();


async function main(io) {
    try {
        const sheetId = process.env.SHEET_ID;
        const saKeyPath = process.env.SA_KEY_PATH || '../sa.json';
        if (!sheetId) throw new Error('❌ Missing SHEET_ID in .env');

        const auth = new GoogleAuth({
            keyFile: path.resolve(saKeyPath),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const lastLead = await LeadModel.findOne({}, { n: 1 }).sort({ n: -1 }).lean();
        const lastRow = lastLead?.n || 1;
        const nextStart = lastRow;
        const nextEnd = nextStart + 10;


        const range = `Asosiy!A${nextStart}:J${nextEnd}`;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
        const rows = response.data.values || [];

        if (!rows.length) {
            return;
        }

        const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const operators = await b1Controller.execute(query);

        let counter = 1;
        const leads = rows
            .map((row, i) => {
                const rowNumber = nextStart + i;
                const parsedTime = parseSheetDate(row[3]);
                const weekday = moment(parsedTime).isoWeekday().toString();

                const availableOperators = operators.filter((item) =>
                    get(item, 'U_workDay', '').split(',').includes(weekday)
                );

                const operator =
                    availableOperators.length > 0
                        ? availableOperators[Math.floor(Math.random() * availableOperators.length)]
                        : null;

                let clientName = row[0]?.trim() || '';
                clientName = clientName.replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '').trim();
                if (!clientName) clientName = `Mijoz_${counter++}`;

                const clientPhone = (row[1] || '').replace(/\D/g, '').slice(0, 12);

                return {
                    n: rowNumber,
                    clientName,
                    clientPhone,
                    source: row[2]?.trim() || '',
                    time: parsedTime,
                    operator: operator?.SlpCode || null,
                    cardCode: null,
                    cardName: null,
                };
            })
            .filter((lead) => lead.clientPhone);

        if (!leads.length) {
            console.log('⚠️ No valid leads with phone numbers.');
            return;
        }

        const phones = leads.map((l) => l.clientPhone?.replace(/\D/g, '')).filter(Boolean);
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
                const phone1 = (r.Phone1 || '').replace(/\D/g, '');
                const phone2 = (r.Phone2 || '').replace(/\D/g, '');
                if (phone1) existingMap.set(phone1, { cardCode: r.CardCode, cardName: r.CardName });
                if (phone2) existingMap.set(phone2, { cardCode: r.CardCode, cardName: r.CardName });
            }
        }

        for (const lead of leads) {
            const match = existingMap.get(lead.clientPhone);
            if (match) {
                lead.cardCode = match.cardCode;
                lead.cardName = match.cardName;
            }
        }

        const uniqueLeads = [];
        for (const lead of leads) {
            const exists = await LeadModel.exists({
                clientPhone: lead.clientPhone,
                clientName: lead.clientName,
                source: lead.source,
                cardCode: lead.cardCode,
            });
            if (!exists) uniqueLeads.push(lead);
        }

        if (!uniqueLeads.length) {
            console.log('✅ No unique new leads found.');
            return;
        }

        const notInSap = uniqueLeads.filter((lead) => !lead.cardCode);
        console.log(`🆕 SAP’da topilmagan yangi clientlar soni: ${notInSap.length}`);

        const inserted = await LeadModel.insertMany(uniqueLeads);
        console.log(`📥 ${inserted.length} new leads inserted into MongoDB.`);

        if (io && inserted.length > 0) {
            io.emit('new_leads', inserted);
            io.emit('new_leads_summary', {
                total: inserted.length,
                notInSap: notInSap.length,
            });
            console.log('📡 Socket broadcast: new_leads + summary sent to all clients');
        }

        console.log('✅ Lead sync completed (CardCode/CardName included).');
    } catch (err) {
        console.error('❌ Error in Google Sheet sync:', err.message || err);
    }
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

module.exports = { main };
