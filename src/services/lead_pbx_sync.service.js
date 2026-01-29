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

    // 998901234567
    if (d.startsWith('998') && d.length >= 12) {
        return { full: d, local: d.slice(3) }; // full=998..., local=9 digits
    }

    // 901234567 (local)
    if (/^\d{9}$/.test(d)) {
        return { full: `998${d}`, local: d };
    }

    // fallback (noyob formatlar)
    return { full: d, local: d.length >= 9 ? d.slice(-9) : d };
}

function buildPbxPhoneNumbersNoPlus(raw) {
    const { full, local } = buildLeadPhoneVariants(raw);
    if (!full && !local) return null;

    // "998...,901..."
    if (full && local) return `${full},${local}`;
    return full || local;
}

function pickOperatorAndClient(call) {
    const userEvent = call.events?.find((e) => e.type === 'user');

    // operator ext: event user.number yoki fallback caller_id_number
    const operatorExt = userEvent?.number ?? call.caller_id_number ?? null;

    // client phone: outbound => destination, inbound => caller
    const clientPhone =
        call.accountcode === 'outbound'
            ? call.destination_number
            : call.caller_id_number;

    return { operatorExt, clientPhone };
}

function isLeadPhoneInCall(call, leadVariants) {
    console.log(call , leadVariants ," bu leadvaritns")
    const a = digitsOnly(call?.caller_id_number ?? '');
    const b = digitsOnly(call?.destination_number ?? '');
    const { full, local } = leadVariants;

    // exact match
    if (full && (a === full || b === full)) return true;
    if (local && (a === local || b === local)) return true;

    // fallback: oxirgi 9 raqam match (format farq qilsa)
    if (local && (a.endsWith(local) || b.endsWith(local))) return true;

    return false;
}

async function syncLeadPbxChats({ pbxClient, leadId }) {
    const lead = await LeadModel.findById(leadId)
        .select('clientPhone createdAt')
        .lean();

    if (!lead?.clientPhone) return;

    const leadVariants = buildLeadPhoneVariants(lead.clientPhone);
    const phone_numbers = buildPbxPhoneNumbersNoPlus(lead.clientPhone);
    if (!phone_numbers) return;

    const now = Math.floor(Date.now() / 1000);
    const leadCreated = Math.floor(new Date(lead.createdAt).getTime() / 1000);

    // ✅ 3 kun oralig'i + lead yaratilgan sanadan keyin
    const from3Days = now - 3 * 24 * 3600;
    const from = Math.max(from3Days, leadCreated);

    // ✅ inbound + outbound ikkalasi ham keladi (accountcode bermaymiz)
    // ✅ faqat gaplashilgan: user_talk_time_from=1
    const res = await pbxClient.searchCalls({
        phone_numbers, // "998...,901..."
        start_stamp_from: from,
        start_stamp_to: now,
        user_talk_time_from: 1,
    });

    console.log({
        phone_numbers, // "998...,901..."
        start_stamp_from: from,
        start_stamp_to: now,
        user_talk_time_from: 1,
    })

    const rawCalls = res?.data ?? [];

    // ✅ gateway filter + lead raqami qatnashganini tekshirish
    const calls = rawCalls
        .filter((c) => String(c.gateway) === COMPANY_GATEWAY)

    console.log(calls , " bu calls")
    if (!calls.length) return;

    const ops = calls.map((c) => {
        const { operatorExt, clientPhone } = pickOperatorAndClient(c);

        const createdAt = new Date((c.start_stamp ?? now) * 1000);
        const duration = Number(c.user_talk_time ?? c.duration ?? 0);

        const createdBy = Number.isFinite(Number(operatorExt)) ? Number(operatorExt) : 0;

        return {
            updateOne: {
                filter: { leadId, 'pbx.uuid': c.uuid },
                update: {
                    $setOnInsert: {
                        leadId,
                        pbx: {
                            uuid: c.uuid,
                            gateway: String(c.gateway ?? ''),
                            accountcode: c.accountcode, // inbound/outbound
                            start_stamp: c.start_stamp,
                            end_stamp: c.end_stamp,
                            operator_ext: operatorExt ? String(operatorExt) : null,
                            client_phone: clientPhone ? String(clientPhone) : null,
                        },
                        // url saqlamaymiz (proxy endpoint bilan berasiz)
                        Audio: { duration },
                        createdBy,
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
        // jim o'tirmang — hech bo'lmasa log qiling
        // console.error('[PBX SYNC bulkWrite]', e?.message);
    }
}

module.exports = { syncLeadPbxChats };
