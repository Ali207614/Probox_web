const express = require('express');
const router = express.Router();

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
            isNewLogicalRow,
            timestamp,
        } = req.body;

        if (!sheetName || sheetName !== 'Asosiy') {
            return res.status(200).json({ message: `Ignored — sheet "${sheetName}" is not Asosiy.` });
        }

        console.log('📩 Google Sheets webhook keldi:');
        console.log(`📄 Sheet: ${sheetName}`);
        console.log(`🧭 Range: ${rangeA1} (Row: ${rowNumber}, Col: ${colNumber})`);
        console.log(`🆕 New value:`, editedValueNew);
        console.log(`⬅️ Old value:`, editedValueOld);
        console.log(`🧾 Row values:`, valuesRow);
        console.log(`🆕 New logical row?: ${isNewLogicalRow}`);
        console.log(`🕓 Timestamp: ${timestamp}`);
        console.log('------------------------------------------');

        // === Bu yerda siz DB yoki boshqa tizimga yozishni amalga oshirasiz ===
        // Masalan:
        // if (isNewLogicalRow) {
        //   await LeadModel.create({ ... });
        // } else {
        //   await LeadModel.update({ ... });
        // }

        return res.status(200).json({ message: 'Webhook received successfully' });
    } catch (error) {
        console.error('❌ Webhook xatosi:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
