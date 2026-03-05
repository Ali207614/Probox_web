'use strict';

require('dotenv').config();

const mongoose = require('mongoose');

const { processClosedEscalation } = require('./utils/lead-bump-notify.cron'); // <-- pathni moslang
const { createOnlinePbx } = require('./controllers/pbx.client'); // <-- sizdagi path

async function connectMongo() {
    const uri = process.env.DB_URL || process.env.DB_URL;
    if (!uri) throw new Error('MONGO_URI (yoki MONGODB_URI) .env da yo‘q');

    // buffering bo‘lmasin desangiz:
    mongoose.set('bufferCommands', false);

    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
    });

    console.log('[TEST] Mongo connected');
}

const pbxClient = createOnlinePbx({
    domain: process.env.PBX_DOMAIN,
    authKey: process.env.PBX_AUTH_KEY,
    apiHost: process.env.PBX_API_HOST || 'https://api2.onlinepbx.ru',
});

const TRUNK_NAME = process.env.PBX_TRUNK_NAME || 'f6813980348e52891f64fa3ce451de69';

async function main() {
    await connectMongo();

    const now = new Date();
    console.log('[TEST] start processClosedEscalation', { now: now.toISOString() });

    const count = await processClosedEscalation(now, {
        pbxClient,
        trunkName: TRUNK_NAME,
    });

    console.log('[TEST] done. escalated:', count);

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async (e) => {
    console.error('[TEST] error:', e?.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});