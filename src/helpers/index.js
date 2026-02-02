const fs = require("fs");
const path = require("path");
const LeadModel = require('../models/lead-model');
const dbService = require('../services/dbService');
const DataRepositories = require("../repositories/dataRepositories");
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

function groupSearchResults(rows) {
    const map = {};

    for (const row of rows) {
        if (!map[row.ItemCode]) {
            map[row.ItemCode] = {
                ItemCode: row.ItemCode,
                ItemName: row.ItemName,
                U_Model: row.U_Model,
                PhonePrice: row.PhonePrice,
                LastPrice: row.LastPrice,
                warehouses: []
            };
        }

        map[row.ItemCode].warehouses.push({
            WhsCode: row.WhsCode,
            OnHand: row.OnHand,
            WhsName: row.WhsName
        });
    }

    return Object.values(map);
}



function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

function normalizePhoneToFull998(raw) {
    const d = digitsOnly(raw);
    if (!d) return null;
    if (d.startsWith('998') && d.length >= 12) return d.slice(0, 12);
    if (/^\d{9}$/.test(d)) return `998${d}`;
    // fallback: oxirgi 9 ta raqamni local deb olib 998 qo'shish
    if (d.length >= 9) return `998${d.slice(-9)}`;
    return null;
}

async function loadOperatorsMap() {
    const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
    const rows = await dbService.execute(query);

    // map: onlinepbx_ext(number) -> SlpCode
    const map = new Map();
    for (const r of rows || []) {
        const ext = Number(r?.U_onlinepbx);
        if (Number.isFinite(ext)) map.set(ext, r?.SlpCode ?? null);
    }
    return map;
}


function pickOperatorExtFromPayload(payload) {
    // ENG KUTILADIGANLAR:
    const candidates = [
        payload.operator_ext,
        payload.user,
        payload.extension,
        payload.ext,
    ].filter(Boolean);

    const n = Number(String(candidates[0] ?? '').trim());
    return Number.isFinite(n) ? n : null;
}


function pickClientPhoneFromWebhook(payload) {
    const dir = String(payload.direction || '').toLowerCase(); // inbound/outbound
    const caller = normalizePhoneToFull998(payload.caller);
    const callee = normalizePhoneToFull998(payload.callee);

    if (dir === 'outbound') return callee || caller; // outbound: client = callee
    return caller || callee; // inbound: client = caller
}


function deriveLeadFields(payload) {
    const dir = String(payload.direction || '').toLowerCase();
    const event = String(payload.event || '').toLowerCase();

    const source = dir === 'outbound' ? 'Chiquvchi' : 'Kiruvchi';

    // 2) duration/billsec/user_talk_time = 0 bo'lsa va inbound bo'lsa
    const talk = Number(payload.user_talk_time ?? payload.billsec ?? payload.duration ?? 0);
    const isMissedByEvent =
        event.includes('miss') || event.includes('no_answer') || event.includes('noanswer');

    const status = (dir !== 'outbound' && (isMissedByEvent || talk <= 0))
        ? 'missed'
        : 'active';

    return { source, status };
}

module.exports = {
    saveSession,
    getSession,
    shuffleArray,
    parseLocalDateString,
    addAndCondition,
    loadOperatorsMap,
    pickOperatorExtFromPayload,
    pickClientPhoneFromWebhook,
    deriveLeadFields,
    groupSearchResults
}