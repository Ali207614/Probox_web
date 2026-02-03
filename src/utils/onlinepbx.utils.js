const DataRepositories = require('../repositories/dataRepositories.js');
const dbService = require('../services/dbService.js');

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

function normalizePhoneToFull998(raw) {
    const d = digitsOnly(raw);
    if (!d) return null;

    if (d.startsWith('998') && d.length >= 12) return d.slice(0, 12);

    if (/^\d{9}$/.test(d)) return `998${d}`;

    if (d.length >= 9) return `998${d.slice(-9)}`;

    return null;
}


function pickOperatorExtFromPayload(payload) {
    const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '');

    const candidates = [payload.caller, payload.callee]
        .map(digitsOnly)
        .filter((x) => x && x.length <= 5);

    const n = Number(String(candidates[0] ?? '').trim());
    return Number.isFinite(n) ? n : null;
}


function pickClientPhoneFromWebhook(payload) {
    const dir = String(payload.direction || '').toLowerCase();

    if (dir === 'outbound') {
        return normalizePhoneToFull998(payload.callee);
    }

    const maybeCaller = normalizePhoneToFull998(payload.caller);
    if (maybeCaller && String(payload.caller).length >= 9) return maybeCaller;

    return (
        normalizePhoneToFull998(payload.callee) ||
        normalizePhoneToFull998(payload.callee_to) ||
        normalizePhoneToFull998(payload.caller_phone) ||
        null
    );
}

function deriveLeadFields(payload) {
    const dir = String(payload.direction || '').toLowerCase();
    const event = String(payload.event || '').toLowerCase();

    const source = dir === 'outbound' ? 'Chiquvchi' : 'Kiruvchi';

    const isMissedByEvent =
        event.includes('call_missed');

    if (isMissedByEvent) return { source, status: 'Missed' };

    if (event === 'call_end' && dir === 'inbound') {
        const dialog = Number(payload.dialog_duration ?? 0);
        if (!Number.isNaN(dialog) && dialog <= 0) return { source, status: 'Missed' };
    }

    return { source, status: 'Active' };
}

async function loadOperatorsMap() {
    const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
    const rows = await dbService.execute(query);

    const map = new Map();
    for (const r of rows || []) {
        const ext = Number(r?.U_onlinepbx);
        if (Number.isFinite(ext)) map.set(ext, r?.SlpCode ?? null);
    }
    return map;
}

module.exports = {
    pickOperatorExtFromPayload,
    pickClientPhoneFromWebhook,
    deriveLeadFields,
    loadOperatorsMap,
};
