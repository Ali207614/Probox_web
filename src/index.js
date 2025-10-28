require('dotenv').config()
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser')
const mongoose = require('mongoose');
const router = require('./router/index')
const errorMiddleware = require('./middlewares/error-middleware');
const hanaClient = require("@sap/hana-client");
const compression = require('compression');
const { PORT, DB_URL, conn_params , CLIENT_URL} = require('./config')
const LeadModel = require("./models/lead-model");
const app = express()
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const path = require('path');
const DataRepositories = require("./repositories/dataRepositories");
const b1Controller = require('./controllers/b1HANA');
const moment = require("moment");
const {get} = require("lodash");

app.use(cors({
    credentials: true,
    origin: [CLIENT_URL, 'http://localhost:3000', "http://localhost:5646", "http://83.69.136.98:5646"]
}));

app.use(cors());

app.use(cookieParser());
app.use(express.json());

app.use(compression({
    threshold: 1024,
    level: 6,
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

app.use('/api', router);
app.use("/api/images", express.static("uploads"));

app.use(errorMiddleware);

async function main() {
    const sheetId = process.env.SHEET_ID;
    const range = process.env.SHEET_RANGE || 'Sheet1!A1:F100';
    const saKeyPath = process.env.SA_KEY_PATH || './sa.json';

    if (!sheetId) throw new Error('❌ Missing SHEET_ID in .env');

    const auth = new GoogleAuth({
        keyFile: path.resolve(saKeyPath),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range,
        });

        const rows = response.data.values || [];
        if (!rows.length) {
            console.log('⚠️ Sheet is empty.');
            return;
        }

        // 🔹 Operatorlarni olish
        const query = DataRepositories.getSalesPersons({
            include: ['Operator1'],
        });
        const data = await b1Controller.execute(query);

        console.log(`✅ ${rows.length} rows read successfully.\n`);

        let counter = 1;
        let operatorIndex = {}; // kun bo‘yicha operator navbati

        const leads = rows.map((row, index) => {
            const parsedTime = parseSheetDate(row[3]);
            const weekday = moment(parsedTime).isoWeekday().toString(); // 1–7

            // Shu kunda ishlaydigan operatorlarni topish
            const availableOperators = data.filter((item) =>
                get(item, 'U_workDay', '').split(',').includes(weekday)
            );

            // Agar shu kunda ishlaydigan operatorlar bo‘lsa, ularni aylantiramiz
            let operator = null;
            if (availableOperators.length > 0) {
                const idx = operatorIndex[weekday] || 0;
                operator = availableOperators[idx % availableOperators.length];
                operatorIndex[weekday] = idx + 1;
            }

            // 🔸 Ismni tozalash
            let clientName = row[0]?.trim() || '';
            clientName = clientName.replace(/[^a-zA-Z\u0400-\u04FF\s]/g, '').trim();
            if (!clientName) {
                clientName = `Mijoz_${counter++}`;
            }

            // 🔸 Telefon raqamni tozalash
            let clientPhone = (row[1] || '').replace(/\D/g, '').slice(0, 12);

            return {
                n: index + 2, // Sheet1!A2 dan boshlangan, shuning uchun +2
                clientName,
                clientPhone,
                source: row[2]?.trim() || '',
                time: parsedTime,
                operator: operator?.SlpCode || null,
            };
        }).filter((lead) => lead.clientPhone);
        await LeadModel.deleteMany();

        const result = await LeadModel.insertMany(leads);
        console.log(`📥 ${result.length} rows inserted into MongoDB.\n`);
    } catch (err) {
        console.log(err)
        console.error('❌ Error reading Google Sheet:');
        if (err.code === 403) {
            console.error('➡️ SA email sheet’ga qo‘shilmagan bo‘lishi mumkin.');
        }
        console.error(err.message || err);
    }
}

function parseSheetDate(value) {
    if (!value) return null;

    if (!isNaN(value)) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        return new Date(excelEpoch.getTime() + value * 86400000);
    }

    const str = String(value).trim().replace(/\//g, '.');
    const parsed = moment(str, ['DD.MM.YYYY HH:mm:ss', 'DD.MM.YYYY H:mm:ss', 'DD.MM.YYYY'], true);
    return parsed.isValid() ? parsed.toDate() : null;
}

const start = async () => {
    try {
        await mongoose.connect(DB_URL, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        })
        console.log(process.env.LEAD === 'true')


        const connection = hanaClient.createConnection();
        connection.connect(conn_params, async (err) => {
            if (err) {
                console.error('Hanaga ulanishda xatolik yuz berdi:', err);
            } else {
                console.log('Hanaga ulanish muvaffaqiyatli amalga oshirildi');
                if(process.env.LEAD === 'true'){
                    main()
                }
            }
        });
        global.connection = connection;

        app.listen(PORT, () => console.log(`Server started on PORT = ${PORT}`))
    } catch (e) {
        console.log(e);
    }
}

start()