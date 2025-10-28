const express = require('express');
const moment = require('moment');
const get = require('lodash/get');
const { LeadModel } = require('../models/lead-model');
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
 * Webhook endpoint for Google Sheets edits
 */
router.post('/webhook', basicAuth, async (req, res) => {
    try {
        const {
            event,
            sheetName,
            rowNumber,
            colNumber,
            rangeA1,
            valuesRow,
            editedValueNew,
            editedValueOld,
            timestamp,
        } = req.body;

        if (!sheetName || sheetName !== 'Asosiy') {
            return res.status(200).json({ message: `Ignored — sheet "${sheetName}" is not Asosiy.` });
        }

        // Faqat yangi yozilgan (old value = null yoki bo‘sh) bo‘lsa
        if (event === 'edit' && (editedValueOld === null || editedValueOld === '')) {

            const [
                clientNameRaw,
                clientPhoneRaw,
                sourceRaw,
                timeRaw,
                , , , , ,
                backupPhone
            ] = valuesRow;

            const clientName = String(clientNameRaw || '').trim();
            const clientPhone = String(clientPhoneRaw || backupPhone || '').replace(/\D/g, '').slice(0, 12);
            const source = String(sourceRaw || '').trim();
            const time = parseSheetDate(timeRaw);

            if (!clientPhone) {
                console.warn('⚠️ Telefon raqam topilmadi, yozilmadi.');
                return res.status(200).json({ message: 'Skipped — no phone number.' });
            }

            const query = DataRepositories.getSalesPersons({
                include: ['Operator1'],
            });
            const operators = await b1Controller.execute(query);

            const weekday = moment(time).isoWeekday().toString(); // 1–7
            const availableOperators = operators.filter((op) =>
                get(op, 'U_workDay', '').split(',').includes(weekday)
            );

            const randomIndex = Math.floor(Math.random() * availableOperators.length);
            const operator = availableOperators[randomIndex] || null;

            const lead = new LeadModel({
                clientName,
                clientPhone,
                source,
                time,
                operator: operator?.SlpCode || null,
            });

            await lead.save();

            console.log(`✅ Yangi lead saqlandi: ${clientName} (${clientPhone})`);
            return res.status(201).json({ message: 'New lead inserted successfully.' });
        }

        console.log(`ℹ️ Tahrir yoki mavjud qatordagi o‘zgarish — o‘tkazildi (Row ${rowNumber})`);
        return res.status(200).json({ message: 'Ignored non-new edit.' });
    } catch (error) {
        console.error('❌ Webhook xatosi:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;

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
