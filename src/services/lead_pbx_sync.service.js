// lead_pbx_sync.service.js
const LeadChat = require('../models/lead-chat-model');
const LeadModel = require('../models/lead-model');
const DataRepositories = require("../repositories/dataRepositories");
const dbService = require("./dbService");

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
    const a = digitsOnly(call?.caller_id_number ?? '');
    const b = digitsOnly(call?.destination_number ?? '');
    const { full, local } = leadVariants;

    if (full && (a === full || b === full)) return true;
    if (local && (a === local || b === local)) return true;

    if (local && (a.endsWith(local) || b.endsWith(local))) return true;

    return false;
}

async function syncLeadPbxChats({ pbxClient, leadId }) {
    const lead = await LeadModel.findById(leadId)
        .select('clientPhone createdAt')
        .lean();

    if (!lead?.clientPhone) return;

   const query = DataRepositories.getSalesPersons({
       include: ['Operator1']
   });
    const operatorData = await dbService.execute(query);
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

    console.log(`[PBX SYNC] ${rawCalls.length} calls found for lead ${leadId}`);

    const calls = rawCalls
        .filter((c) => String(c.gateway) === COMPANY_GATEWAY)

    if (!calls.length) return;

    const ops = calls.map((c) => {
        const { operatorExt, clientPhone } = pickOperatorAndClient(c);

        const createdAt = new Date((c.start_stamp ?? now) * 1000);
        const duration = Number(c.user_talk_time ?? c.duration ?? 0);

        const createdBy = Number.isFinite(Number(operatorExt)) ? Number(operatorExt) : 0;
        const operator = operatorData.find(el => el?.U_onlinepbx == createdBy);
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
                        createdBy:operator?.SlpCode || null,
                        message: `📞 Call recording (${c.accountcode})`,
                        createdAt,
                    },
                    $set: {
                        createdBy: operator?.SlpCode || null,
                        'Audio.duration': duration,
                        'pbx.operator_ext': operatorExt ? String(operatorExt) : null,
                        'pbx.client_phone': clientPhone ? String(clientPhone) : null,
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
