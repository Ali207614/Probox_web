require('dotenv').config()
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser')
const mongoose = require('mongoose');
const router = require('./router/index')
const errorMiddleware = require('./middlewares/error-middleware');
const hanaClient = require("@sap/hana-client");

const { PORT, DB_URL, CLIENT_URL, conn_params } = require('./config')
const app = express()

app.use(express.json());
app.use(cookieParser());
app.use(cors({
    credentials: true,
    origin: CLIENT_URL
}));
app.use(errorMiddleware);
app.use('/api', router);

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
