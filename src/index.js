require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const compression = require('compression');
const hanaClient = require('@sap/hana-client');
const ErrorMiddleware = require('./middlewares/error-middleware');
const { main } = require('../src/utils/googleSheetSync');
const googleSheetRouter = require('../src/router/googleSheetWebhook');
const router = require('../src/router/index');
const { PORT, DB_URL, conn_params, CLIENT_URL } = require('./config');
const leadImageRoute = require('../src/router/leadImageRoute');
const path = require('path');
const app = express();
const server = http.createServer(app);
const { startExpireLeadLimitsCron } = require('./utils/expire-lead-limits');
const {startConsideringBumpCron} = require("./utils/considering-newtime.cron");
const {startWillVisitStoreBumpCron} = require("./utils/will-visit-store-bump.cron");
//require('./utils/cronBusinessPartners');
app.use(express.urlencoded({ extended: false }));
// === SOCKET.IO ===
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ['GET', 'POST'],
        credentials: true,
    },
});

global.io = io;

// === MIDDLEWARES ===

app.use(cors({
    origin: '*',
    credentials: true,
}));
app.use(express.json());
app.use(compression());

// === SOCKET.IO’ni app ga qo‘shish ===
app.set('io', io);

// === ROUTES ===
app.use('/api', googleSheetRouter);
app.use('/api', router);
app.use('/api/lead-images', leadImageRoute);

app.use('/api/images', express.static(path.resolve(__dirname, '../uploads')));

app.use(ErrorMiddleware)
// === DATABASE (MongoDB) ===
const MONGO_URI = DB_URL || process.env.MONGO_URI || 'mongodb://localhost:27017/probox';
mongoose
    .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('🟢 MongoDB connected'))
    .catch((err) => console.error('❌ MongoDB connection error:', err));

// === SOCKET.IO EVENTS ===
io.on('connection', (socket) => {
    console.log('🟣 Client connected:', socket.id);
    socket.on('disconnect', () => console.log('🔴 Client disconnected:', socket.id));
});

//require("./utils/cronInvoice");

startExpireLeadLimitsCron();
startConsideringBumpCron()
startWillVisitStoreBumpCron()
// === SERVER ===
const port = PORT || 3019;
server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});

// === SAP HANA va Google Sheet Sync ===
(async () => {
    try {
        console.log('⏳ Running initial Google Sheet sync...');
        const connection = hanaClient.createConnection();

        connection.connect(conn_params, async (err) => {
            if (err) {
                console.error('❌ SAP HANA ulanishda xatolik:', err);
            } else {
                console.log('🟢 Hanaga ulanish muvaffaqiyatli amalga oshirildi');
                global.connection = connection;
                if (process.env.LEAD === 'true') {
                    await main(io);
                }
            }
        });

    } catch (err) {
        console.error('❌ Initial sync failed:', err.message);
    }
})();
