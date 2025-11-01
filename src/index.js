require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const compression = require('compression'); // 🧩 qo‘shildi
const hanaClient = require('@sap/hana-client');

const { main } = require('../src/utils/googleSheetSync');
const googleSheetRouter = require('../src/router/googleSheetWebhook');
const router = require('../src/router/index')
const { PORT, DB_URL, conn_params, CLIENT_URL } = require('./config');
const { ensureBucket } = require('./minio');
const leadImageRoute = require('../src/router/leadImageRoute');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: CLIENT_URL || '*', // frontend domen
    },
});

// === Middlewares
app.use(cors());
app.use(express.json());
app.use(compression()); // 🧩 barcha HTTP response’larni siqadi

// === Socket.io ni app obyektiga biriktirish (routerlarda ishlatish uchun)
app.set('io', io);

// === Routers
app.use('/api', googleSheetRouter);
app.use('/api', router);
app.use('/api/lead-images', leadImageRoute);

// === MongoDB ulanish
const MONGO_URI = DB_URL || process.env.MONGO_URI || 'mongodb://localhost:27017/probox';
mongoose
    .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('🟢 MongoDB connected'))
    .catch((err) => console.error('❌ MongoDB connection error:', err));

// === Socket.io hodisalarini kuzatish
io.on('connection', (socket) => {
    console.log('🟣 Client connected:', socket.id);
    socket.on('disconnect', () => console.log('🔴 Client disconnected:', socket.id));
});

// === Server ishga tushirish
const port = PORT || 3019;
server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});

// === SAP HANA va Google Sheets sync
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

                // faqat LEAD=true bo‘lsa, sync ishga tushadi
                if (process.env.LEAD === 'true') {
                    await main(io);
                }
            }
        });

        //await ensureBucket(process.env.MINIO_BUCKET);
    } catch (err) {
        console.error('❌ Initial sync failed:', err.message);
    }
})();
