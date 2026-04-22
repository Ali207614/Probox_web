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
const { PORT, DB_URL, conn_params } = require('./config');
const leadImageRoute = require('../src/router/leadImageRoute');
const path = require('path');
const app = express();
const server = http.createServer(app);
const { startExpireLeadLimitsCron } = require('./utils/expire-lead-limits');
const {startLeadBumpCron} = require("./utils/lead-bump.cron");
const {startLeadAutoIgnoreCron} = require("./utils/lead-auto-ignore.cron");
const {startLeadRecallBumpCron} = require("./utils/lead-recall-bump.cron");
const {startLeadBumpNotifyCron} = require("./utils/lead-bump-notify.cron");
const {startSellerBumpNotifyCron} = require("./utils/seller-bump-notify-cron");
const {startScoringBumpNotifyCron} = require("./utils/scoring-bump-notify.cron");
const {pbxClient, TRUNK_NAMES} = require("./integrations/pbx");
const {startRatingSmsCron} = require("./utils/rating-sms.cron");
const {startReservationExpireCron} = require("./utils/reservation-expire.cron");
const startMehrliCallJob = require("./utils/mehrli-call-job");
const tokenService = require('./services/tokenService');
const RefreshFlag = require('./models/refresh-flag-model');

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

// === SOCKET.IO AUTH ===
io.use((socket, next) => {
    try {
        const token =
            socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization ||
            socket.handshake.query?.token;

        if (!token) return next();

        const userData = tokenService.validateAccessToken(token);
        if (!userData) return next();

        socket.user = userData;
        return next();
    } catch (e) {
        return next();
    }
});

// === SOCKET.IO EVENTS ===
io.on('connection', async (socket) => {
    console.log('🟣 Client connected:', socket.id);

    const slpCode = socket.user?.SlpCode;
    if (slpCode != null) {
        socket.join(`slp:${slpCode}`);

        try {
            const flag = await RefreshFlag.findOne({ slpCode });
            if (flag?.force_refresh) {
                socket.emit('force-refresh', {
                    message: 'Iltimos, sahifani yangilang',
                });
                // ❗ flagni bu yerda o'chirmaymiz — frontend ACK kutamiz
            }
        } catch (err) {
            console.error('❌ force-refresh tekshirishda xatolik:', err.message);
        }
    }

    // Frontend sahifani yangilaganda yuboradi
    socket.on('force-refresh:done', async () => {
        try {
            const slp = socket.user?.SlpCode;
            if (slp != null) {
                await RefreshFlag.updateOne(
                    { slpCode: slp },
                    { $set: { force_refresh: false } }
                );
            }
        } catch (err) {
            console.error('❌ force-refresh:done xatolik:', err.message);
        }
    });

    socket.on('disconnect', () => console.log('🔴 Client disconnected:', socket.id));
});

//require("./utils/cronInvoice");

startExpireLeadLimitsCron();
startLeadBumpCron()
startLeadAutoIgnoreCron()
startLeadRecallBumpCron()
startSellerBumpNotifyCron()
startScoringBumpNotifyCron()
startRatingSmsCron()
startMehrliCallJob()
startReservationExpireCron()

startLeadBumpNotifyCron({
    pbxClient,
    trunkNames: TRUNK_NAMES
});
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

                console.log(conn_params ," bu conn err")
                console.error('❌ SAP HANA ulanishda xatolik:', err);
            } else {
                console.log(conn_params ," bu conn success")

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
