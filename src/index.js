require('dotenv').config()
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser')
const mongoose = require('mongoose');
const router = require('./router/index')
const errorMiddleware = require('./middlewares/error-middleware');
const hanaClient = require("@sap/hana-client");
const compression = require('compression');

const { PORT, DB_URL, CLIENT_URL, conn_params } = require('./config')
const app = express()


// app.use(cors({
//     credentials: true,
//     origin: [CLIENT_URL, 'http://localhost:3000', "http://localhost:5646", "http://83.69.136.98:5646"]
// }));

app.use(cors());

app.use(cookieParser());
app.use(express.json());

app.use(compression({
    threshold: 1024, // faqat 1KB dan katta javoblar siqiladi
    level: 6,        // gzip siqish darajasi (0–9)
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false; // maxsus header orqali siqishni o‘chirib qo‘yish
        }
        return compression.filter(req, res);
    }
}));

app.use('/api', router);
app.use("/api/images", express.static("uploads"));

app.use(errorMiddleware);

app.use((req, res, next) => {
    res.status(404).json({
        message: 'Endpoint not found',
        error: [],
    });
});
const start = async () => {
    try {
        await mongoose.connect(DB_URL, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        })

        const connection = hanaClient.createConnection();
        connection.connect(conn_params, async (err) => {
            if (err) {
                console.error('Hanaga ulanishda xatolik yuz berdi:', err);
            } else {
                console.log('Hanaga ulanish muvaffaqiyatli amalga oshirildi');
            }
        });
        global.connection = connection;

        app.listen(PORT, () => console.log(`Server started on PORT = ${PORT}`))
    } catch (e) {
        console.log(e);
    }
}

start()
