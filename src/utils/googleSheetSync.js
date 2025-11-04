const path = require('path');
const moment = require('moment');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { get } = require('lodash');
const LeadModel = require('../models/lead-model');
const DataRepositories = require('../repositories/dataRepositories');
const b1Controller = require('../controllers/b1HANA');
require('dotenv').config();


function normalizePhone(input) {
    if (!input) return null;
    let digits = String(input).replace(/\D/g, '');

    if (digits.startsWith('998') && digits.length > 9) {
        digits = digits.slice(3);
    }

    if (digits.length === 10 && digits.startsWith('0')) {
        digits = digits.slice(1);
    }
    return digits;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function getWeekdaySafe(dateLike) {
    const m = moment(dateLike);
    if (!m.isValid()) {
        return moment().isoWeekday().toString(); // '1'..'7'
    }
    return m.isoWeekday().toString();
}

async function main(io) {
    try {
        const sheetId = process.env.SHEET_ID;
        const saKeyPath = process.env.SA_KEY_PATH;

        if (!saKeyPath) throw new Error('❌ Missing SA_KEY_PATH in .env');

        const auth = new GoogleAuth({
            keyFile: path.resolve(saKeyPath),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const lastLead = await LeadModel.findOne({}, { n: 1 }).sort({ n: -1 }).lean();
        const lastRow = (lastLead?.n > 50 ? lastLead?.n - 50 : 1) || 1;
        const nextStart = lastRow;
        const nextEnd = nextStart +15000;

        const range = `Asosiy!A${nextStart}:J${nextEnd}`;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
        const rows = response.data.values || [];
        if (!rows.length) {
            console.log('⚠️ No rows found in Google Sheet.');
            return;
        }

        const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
        const operators = await b1Controller.execute(query);
        const allOperatorCodes = operators.map((op) => op.SlpCode);
        if (!allOperatorCodes.length) throw new Error('❌ No operators found in SAP.');

        const leads = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = nextStart + i;
            const parsedTime = parseSheetDate(row[3]);
            const weekday = moment(parsedTime).isoWeekday().toString();

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
                weekday,
                cardCode: null,
                cardName: null,
            });
        }

        if (!leads.length) {
            console.log('⚠️ No valid leads after normalization.');
            return;
        }

        const phones = Array.from(new Set(leads.map((l) => l.clientPhone)));
        let existingMap = new Map();

        if (phones.length > 0) {
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

        const uniqueLeads = [];
        for (const lead of leads) {
            const exists = await LeadModel.exists({
                clientPhone: lead.clientPhone,
                clientName: lead.clientName,
                source: lead.source,
                n: lead.n,
            });
            if (!exists) uniqueLeads.push(lead);
        }

        if (!uniqueLeads.length) {
            console.log('✅ No unique new leads found.');
            return;
        }

        const totalLeads = uniqueLeads.length;
        let index = 0;


        for (const lead of uniqueLeads) {
            const weekday = getWeekdaySafe(lead.time)

            if (lead.source?.trim() === 'Organika') {
                lead.operator = null;
                continue;
            }
            const availableOperators = operators.filter((op) => {
                if (!op.U_workDay) return false;
                const workDays = op.U_workDay;
                return workDays.includes(weekday);
            });

            if (!availableOperators.length) {
                lead.operator = null;
                continue;
            }

            lead.operator = availableOperators[index % availableOperators.length].SlpCode;
            index++;
        }


        const notInSap = uniqueLeads.filter((lead) => !lead.cardCode);
        const inserted = await LeadModel.insertMany(uniqueLeads);
        console.log(`📥 ${inserted.length} new leads inserted into MongoDB.`);
        console.log(`🆕 SAP’da topilmagan yangi clientlar soni: ${notInSap.length}`);

        if (io && inserted.length > 0) {
            io.emit('new_leads_summary', {
                total: inserted.length,
                notInSap: notInSap.length,
            });
            console.log('📡 Socket broadcast: new_leads + summary sent to all clients');
        }

        const operatorStats = {};
        for (const lead of uniqueLeads) {
            operatorStats[lead.operator] = (operatorStats[lead.operator] || 0) + 1;
        }
        console.table(operatorStats);

        console.log('✅ Lead sync completed (balanced operator assignment + 998 normalized).');
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
