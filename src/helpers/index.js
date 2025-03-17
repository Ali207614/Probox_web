const fs = require("fs");
const { get } = require("lodash");
const path = require("path");
const moment = require('moment');



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





module.exports = {
    saveSession,
    getSession,
    formatterCurrency,
}