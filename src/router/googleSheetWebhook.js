// routes/googleSheetWebhook.js
const express = require('express');
const router = express.Router();

const AUTH_USER = process.env.GS_WEBHOOK_USER || 'sheetbot';
const AUTH_PASS = process.env.GS_WEBHOOK_PASS || 'supersecret';


function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Basic ')) {
        return res.status(401).json({ message: 'Missing or invalid Authorization header' });
    }

    // Base64 decode
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');

    if (username !== AUTH_USER || password !== AUTH_PASS) {
        return res.status(403).json({ message: 'Invalid credentials' });
    }

    next();
}


router.post('/webhook', basicAuth, async (req, res) => {
    try {
        const { event, sheetName, values, rowNumber, timestamp } = req.body;

        console.log('📩 Google Sheet webhook keldi:', {
            event,
            sheetName,
            rowNumber,
            values,
            timestamp,
        });

        // Masalan:
        // if (event === 'insert') await LeadModel.create({ ... });

        res.status(200).json({ message: 'Webhook received successfully' });
    } catch (error) {
        console.error('❌ Webhook xatosi:', error);
        res.status(500).json({ message: 'Internal error' });
    }
});

module.exports = router;