const LeadModel = require('../models/lead-model');
const DataRepositories = require('../repositories/dataRepositories');
const dbService = require('./dbService');

const TRUNK_NAME = 'f6813980348e52891f64fa3ce451de69';

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

function buildLeadPhoneVariants(raw) {
    const d = digitsOnly(raw);
    if (!d) return { full: null, local: null };

    // 998901234567
    if (d.startsWith('998') && d.length >= 12) {
        return { full: d, local: d.slice(3) };
    }

    // 901234567
    if (/^\d{9}$/.test(d)) {
        return { full: `998${d}`, local: d };
    }

    // fallback
    return { full: d, local: d.length >= 9 ? d.slice(-9) : d };
}

function pickOperatorAndClient(call) {
    const userEvent = Array.isArray(call?.events)
        ? call.events.find((e) => e?.type === 'user')
        : null;

    // operator ext
    const operatorExt = userEvent?.number ?? call?.caller_id_number ?? null;

    // client phone:
    // outbound => destination, inbound => caller
    const clientPhone =
        call?.accountcode === 'outbound'
            ? call?.destination_number
            : call?.caller_id_number;

    return { operatorExt, clientPhone };
}

function toUnixSec(value) {
    if (!value) return null;

    const d = new Date(value);
    const t = Math.floor(d.getTime() / 1000);

    return Number.isFinite(t) ? t : null;
}

/**
 * Lead time range rule:
 * - from = lead.time
 * - to   = lead.newTime (if exists and >= time)
 * - else to = lead.time + 1 day (buffer)
 */
function buildLeadPbxRange(lead) {
    const from = toUnixSec(lead?.time);
    if (!from) return null;

    const newTime = toUnixSec(lead?.newTime);

    if (newTime && newTime >= from) {
        return {
            start_stamp_from: from,
            start_stamp_to: newTime,
        };
    }

    // newTime yo'q bo'lsa exact second juda tor bo'lib qoladi.
    // Buffer qo'shamiz (1 kun).
    return {
        start_stamp_from: from,
        start_stamp_to: from + 24 * 60 * 60,
    };
}

function normalizePbxCallsArray(res) {
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res)) return res;
    return [];
}

/**
 * ✅ Main function:
 * PBX'dan leadga tegishli calllarni olib keladi va frontend chat formatiga map qiladi
 * DBga write qilmaydi
 */
async function fetchLeadPbxChats({ pbxClient, leadId }) {
    if (!pbxClient) throw new Error('pbxClient is required');
    if (!leadId) return [];

    const lead = await LeadModel.findById(leadId)
        .select('clientPhone time newTime')
        .lean();

    if (!lead?.clientPhone) return [];

    const leadPhones = buildLeadPhoneVariants(lead.clientPhone);
    if (!leadPhones.local && !leadPhones.full) return [];

    const pbxRange = buildLeadPbxRange(lead);
    if (!pbxRange) return [];

    // OnlinePBX 1 haftalik limit:
    // Agar interval > 7 kun bo'lsa, bo'lib yuboramiz.
    const MAX_RANGE_SEC = 7 * 24 * 60 * 60;

    const query = DataRepositories.getSalesPersons({
        include: ['Operator1'],
    });

    const operatorData = await dbService.execute(query);

    const allCalls = [];
    let cursorFrom = pbxRange.start_stamp_from;
    const finalTo = pbxRange.start_stamp_to;

    while (cursorFrom <= finalTo) {
        const chunkTo = Math.min(cursorFrom + MAX_RANGE_SEC - 1, finalTo);

        const res = await pbxClient.searchCalls({
            // ✅ sub_phone_numbers sizda ishonchli ishlayapti
            sub_phone_numbers: leadPhones.local || digitsOnly(lead.clientPhone),

            start_stamp_from: cursorFrom,
            start_stamp_to: chunkTo,

            user_talk_time_from: 1, // faqat gaplashilgan
            sort_by: 'start_stamp',
            sort_order: 'asc',
            trunk_names: TRUNK_NAME,
        });

        const chunkCalls = normalizePbxCallsArray(res);
        if (chunkCalls.length) allCalls.push(...chunkCalls);

        cursorFrom = chunkTo + 1;
    }

    if (!allCalls.length) return [];

    // UUID bo'yicha dedup
    const seen = new Set();
    const uniqueCalls = [];

    for (const call of allCalls) {
        const uuid = String(call?.uuid ?? '');
        if (!uuid) continue;
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        uniqueCalls.push(call);
    }

    // Frontend chat formatiga map
    const mapped = uniqueCalls.map((c) => {
        const { operatorExt, clientPhone } = pickOperatorAndClient(c);

        const startStamp = Number(c?.start_stamp) || Math.floor(Date.now() / 1000);
        const createdAt = new Date(startStamp * 1000);

        const duration = Number(c?.user_talk_time ?? c?.duration ?? 0);
        const createdByNum = Number(operatorExt);

        const operator =
            Number.isFinite(createdByNum)
                ? operatorData.find((el) => Number(el?.U_onlinepbx) === createdByNum)
                : null;

        return {
            _id: `pbx_${c.uuid}`, // fake id (mongo _id emas)
            leadId: String(leadId),
            pbx: {
                uuid: c?.uuid ?? null,
                gateway: String(c?.gateway ?? ''),
                accountcode: c?.accountcode ?? null, // inbound/outbound
                start_stamp: c?.start_stamp ?? null,
                end_stamp: c?.end_stamp ?? null,
                operator_ext: operatorExt ? String(operatorExt) : null,
                client_phone: clientPhone ? String(clientPhone) : null,
            },
            message: `📞 Call recording (${c?.accountcode ?? 'unknown'})`,
            createdBy: operator?.SlpCode || null,
            createdByRole: null,
            Audio: {
                duration: Number.isFinite(duration) ? duration : 0,
            },
            isDeleted: false,
            createdAt,
            updatedAt: createdAt,

            // debug uchun (xohlasangiz olib tashlang)
            _source: 'pbx_live',
        };
    });

    // createdAt asc
    mapped.sort((a, b) => {
        const ta = new Date(a.createdAt).getTime();
        const tb = new Date(b.createdAt).getTime();
        return ta - tb;
    });

    return mapped;
}

module.exports = {
    fetchLeadPbxChats,
    // xohlasangiz helperlarni ham export qiling (test/debug uchun)
    buildLeadPhoneVariants,
    buildLeadPbxRange,
};