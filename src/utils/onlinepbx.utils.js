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
    const digitsOnlyLocal = (v) => String(v ?? '').replace(/\D/g, '');

    const candidates = [payload.caller, payload.callee]
        .map(digitsOnlyLocal)
        .filter((x) => x && x.length <= 3);

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

/**
 * ✅ Status qoidalari:
 * - outbound:
 *   - call_missed yoki call_end dialog_duration=0 -> NoAnswer
 *   - else -> Active
 * - inbound:
 *   - call_missed yoki call_end dialog_duration=0 -> Missed
 *   - else -> Active
 */
function deriveLeadFields(payload) {
    const dir = String(payload.direction || '').toLowerCase();
    const event = String(payload.event || '').toLowerCase();

    const source = dir === 'outbound' ? 'Chiquvchi' : 'Kiruvchi';

    const dialog = Number(payload.dialog_duration ?? 0);
    const hasTalk = Number.isFinite(dialog) && dialog > 0;

    // OUTBOUND
    if (dir === 'outbound') {
        if (event.includes('call_missed')) return { source, status: 'NoAnswer' };
        if (event === 'call_end' && !hasTalk) return { source, status: 'NoAnswer' };
        return { source, status: 'Active' };
    }

    // INBOUND
    if (event.includes('call_missed')) return { source, status: 'Missed' };
    if (event === 'call_end' && !hasTalk) return { source, status: 'Missed' };

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
