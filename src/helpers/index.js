const fs = require("fs");
const { get } = require("lodash");
const path = require("path");
const moment = require('moment');

function parseLocalDateString(str) {
    const [year, month, day] = str.split('.').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0)); // UTC 00:00
}


function formatterCurrency(
    number = 0,
    currency = "UZS",
    locale = "ru",
    maximumSignificantDigits = 10
) {
    return number.toLocaleString(locale, {
        style: "currency",
        currency: currency,
        maximumSignificantDigits: maximumSignificantDigits,
    });
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // Elementlarni joylarini almashtirish
    }
    return array;
}

function saveSession(cookie) {
    fs.writeFileSync(
        path.join(process.cwd(), "database", "session.json"),
        JSON.stringify(cookie, null, 4)
    );
}
function getSession() {
    let docs = fs.readFileSync(
        path.join(process.cwd(), "database", "session.json"),
        "UTF-8"
    );
    docs = docs ? JSON.parse(docs) : {};
    return docs
}

function convertToISOFormat(dateString) {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date.toISOString().split('T')[0];
}
// Kengaytmani tekshirish funksiyasi
function checkFileType(file) {
    const extname = allowedFileTypes.test(path.extname(file.name).toLowerCase());
    const mimetype = allowedFileTypes.test(file.mimetype);
    return extname && mimetype;
}



module.exports = {
    saveSession,
    getSession,
    formatterCurrency,
    convertToISOFormat,
    shuffleArray,
    checkFileType,
    parseLocalDateString
}