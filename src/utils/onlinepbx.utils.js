const DataRepositories = require('../repositories/dataRepositories.js');
const dbService = require('../services/dbService.js');

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

function normalizePhoneToFull998(raw) {
    const d = digitsOnly(raw);
    if (!d) return null;

    // already full
    if (d.startsWith('998') && d.length >= 12) return d.slice(0, 12);

    // local 9 digits: 901234567
    if (/^\d{9}$/.test(d)) return `998${d}`;

    // fallback: take last 9 digits, add 998
    if (d.length >= 9) return `998${d.slice(-9)}`;

    return null;
}

/**
 * Sizning payloadda operator ext = caller (106/111).
 * Ba'zi eventlarda boshqa field ham bo'lishi mumkin, shuning uchun fallback qildik.
 */
function pickOperatorExtFromPayload(payload) {
    const candidates = [
        payload.calle,
    ].filter((x) => x != null && x !== '');

    const n = Number(String(candidates[0] ?? '').trim());
    return Number.isFinite(n) ? n : null;
}

/**
 * Sizning outbound payloadlarda: callee = client phone (9 digits ham bo'lishi mumkin)
 * inbound payloadlarda: odatda caller = client phone bo'ladi,
 * lekin siz ko'rsatgan inbound transfer eventda caller=operator bo'lib kelgan — u holda phone yo'q bo'lishi mumkin.
 */
function pickClientPhoneFromWebhook(payload) {
    const dir = String(payload.direction || '').toLowerCase();

    if (dir === 'outbound') {
        // outbound: client = callee
        return normalizePhoneToFull998(payload.callee);
    }

    // inbound: client = caller (agar caller haqiqatan telefon bo'lsa)
    const maybeCaller = normalizePhoneToFull998(payload.caller);
    if (maybeCaller && String(payload.caller).length >= 9) return maybeCaller;

    // ba'zan inboundda client phone boshqa fieldlarda bo'ladi:
    return (
        normalizePhoneToFull998(payload.callee) ||
        normalizePhoneToFull998(payload.callee_to) ||
        normalizePhoneToFull998(payload.caller_phone) ||
        null
    );
}

/**
 * Source + Status:
 * - source: outbound => Chiquvchi, inbound => Kiruvchi
 * - status: default active
 * - missed: faqat missed/no_answer event bo'lsa yoki call_end(inbound) dialog_duration=0 bo'lsa
 *
 * call_user_start ham call_start kabi (boshlanish)
 */
function deriveLeadFields(payload) {
    const dir = String(payload.direction || '').toLowerCase();
    const event = String(payload.event || '').toLowerCase();

    const source = dir === 'outbound' ? 'Chiquvchi' : 'Kiruvchi';

    // explicit missed events
    const isMissedByEvent =
        event.includes('call_missed');

    if (isMissedByEvent) return { source, status: 'Missed' };

    // call_end inbound + dialog_duration=0 => missed
    if (event === 'call_end' && dir === 'inbound') {
        const dialog = Number(payload.dialog_duration ?? 0);
        if (!Number.isNaN(dialog) && dialog <= 0) return { source, status: 'Missed' };
    }

    return { source, status: 'Active' };
}

function normalizeOnlinePbxPayload(body) {
    const out = {};
    for (const [k, v] of Object.entries(body || {})) {
        if (v === 'no value' || v === '' || v == null) out[k] = null;
        else out[k] = v;
    }

    // date or data (ba'zi eventlarda data keladi)
    const ts = out.date ?? out.data;
    if (ts) {
        const n = Number(ts);
        if (!Number.isNaN(n)) out.date_iso = new Date(n * 1000).toISOString();
    }

    // uuid sanitize
    if (typeof out.uuid === 'string') {
        out.uuid = out.uuid.trim();
        if (!out.uuid) out.uuid = null;
        else {
            const m = out.uuid.match(
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
            );
            if (m) out.uuid = m[0];
        }
    }

    return out;
}

/**
 * Operator ext -> SlpCode map
 * Cache qilmoqchi bo'lsangiz, service ichida 30-60s TTL qilib qo'yamiz.
 */
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
