const fs = require("fs");
const path = require("path");

function parseLocalDateString(str) {
    const [year, month, day] = str.split('.').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0)); // UTC 00:00
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function addAndCondition(filter, condition) {
    if (!filter.$and) filter.$and = [];
    filter.$and.push(condition);
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
    shuffleArray,
    parseLocalDateString,
    addAndCondition,

}