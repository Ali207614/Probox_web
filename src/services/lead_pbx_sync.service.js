// lead_pbx_sync.service.js
const LeadChat = require('../models/lead-chat-model');
const LeadModel = require('../models/lead-model');

const COMPANY_GATEWAY = '781134774';

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

function buildLeadPhoneVariants(raw) {
    const d = digitsOnly(raw);
    if (!d) return { full: null, local: null };

    if (d.startsWith('998') && d.length >= 12) {
        return { full: d, local: d.slice(3) };
    }

    if (/^\d{9}$/.test(d)) {
        return { full: `998${d}`, local: d };
    }

    return { full: d, local: d.length >= 9 ? d.slice(-9) : d };
}

function buildPbxPhoneNumbersNoPlus(raw) {
    const { full, local } = buildLeadPhoneVariants(raw);
    if (!full && !local) return null;
    if (full && local) return `${full},${local}`;
    return full || local;
}

function pickOperatorAndClient(call) {
    const userEvent = call.events?.find((e) => e.type === 'user');
    const operatorExt = userEvent?.number ?? call.caller_id_number ?? null;

    const clientPhone =
        call.accountcode === 'outbound'
            ? call.destination_number
            : call.caller_id_number;

    return { operatorExt, clientPhone };
}

/**
 * --------- SalesPerson mapping (PBX ext -> SlpCode) ----------
 * DataRepositories.getSalesPersons() return qiladigan rowlar ichida:
 *   - SlpCode (yoki "SlpCode")
 *   - U_onlinepbx (yoki "U_onlinepbx")
 * bo‘lishi kerak.
 */
let salesPersonMapCache = {
    map: null,
    expiresAt: 0,
};

async function getSalesPersonMap({ DataRepositories, execute, ttlMs = 5 * 60 * 1000 }) {
    const now = Date.now();
    if (salesPersonMapCache.map && salesPersonMapCache.expiresAt > now) {
        return salesPersonMapCache.map;
    }

    // Sizda shunaqa ishlaydi deb faraz qilyapman:
    // const sql = DataRepositories.getSalesPersons();
    // const rows = await execute(sql);
    const sql = DataRepositories.getSalesPersons();
    const rows = await execute(sql);

    const map = new Map();
    for (const r of rows || []) {
        const slpCode = Number(r.SlpCode ?? r["SlpCode"]);
        const pbxExtRaw = r.U_onlinepbx ?? r["U_onlinepbx"] ?? r.u_onlinepbx ?? r["u_onlinepbx"];

        const ext = digitsOnly(pbxExtRaw);
        if (!ext) continue;
        if (!Number.isFinite(slpCode)) continue;

        // ext -> slpCode
        map.set(ext, slpCode);
    }

    salesPersonMapCache = { map, expiresAt: now + ttlMs };
    return map;
}

function resolveCreatedBySlpCode(operatorExt, spMap) {
    const ext = digitsOnly(operatorExt);
    if (!ext) return 0;

    const slpCode = spMap?.get(ext);
    return Number.isFinite(Number(slpCode)) ? Number(slpCode) : 0;
}

async function syncLeadPbxChats({ pbxClient, leadId, DataRepositories, execute }) {
    const lead = await LeadModel.findById(leadId)
        .select('clientPhone createdAt')
        .lean();

    if (!lead?.clientPhone) return;

    const phone_numbers = buildPbxPhoneNumbersNoPlus(lead.clientPhone);
    if (!phone_numbers) return;

    const now = Math.floor(Date.now() / 1000);

    const res = await pbxClient.searchCalls({
        phone_numbers,
        user_talk_time_from: 1,
        sort_by: 'start_stamp',
        sort_order: 'asc',
        trunk_names: 'f6813980348e52891f64fa3ce451de69',
    });

    const rawCalls = res?.data ?? [];

    const calls = rawCalls.filter((c) => String(c.gateway) === COMPANY_GATEWAY);
    if (!calls.length) return;

    // 1 marta map olib qo‘yamiz (cache ham bor)
    const spMap = await getSalesPersonMap({ DataRepositories, execute });

    const ops = calls.map((c) => {
        const { operatorExt, clientPhone } = pickOperatorAndClient(c);

        const createdAt = new Date((c.start_stamp ?? now) * 1000);
        const duration = Number(c.user_talk_time ?? c.duration ?? 0);

        // operatorExt -> SlpCode
        const createdBy = resolveCreatedBySlpCode(operatorExt, spMap);

        return {
            updateOne: {
                filter: { leadId, 'pbx.uuid': c.uuid },
                update: {
                    $setOnInsert: {
                        leadId,
                        pbx: {
                            uuid: c.uuid,
                            gateway: String(c.gateway ?? ''),
                            accountcode: c.accountcode,
                            start_stamp: c.start_stamp,
                            end_stamp: c.end_stamp,
                            operator_ext: operatorExt ? String(operatorExt) : null,
                            client_phone: clientPhone ? String(clientPhone) : null,
                        },
                        Audio: { duration },
                        createdBy, // <-- endi SlpCode bo‘lyapti
                        message: `📞 Call recording (${c.accountcode})`,
                        createdAt,
                    },
                },
                upsert: true,
            },
        };
    });

    try {
        await LeadChat.bulkWrite(ops, { ordered: false });
    } catch (e) {
        // console.error('[PBX SYNC bulkWrite]', e?.message);
    }
}

module.exports = { syncLeadPbxChats };
