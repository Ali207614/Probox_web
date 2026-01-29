// lead_pbx_sync.service.js
const LeadChat = require('../models/lead-chat-model'); // sizning model
const LeadModel = require('../models/lead-model');    // sizning model

const COMPANY_GATEWAY = '781134774';

function normalizePhone(p = '') {
    // +998... bo'lsa + qolsin, boshqa belgilarni olib tashlaymiz
    return String(p).replace(/[^\d+]/g, '');
}

function pickOperatorAndClient(call) {
    const userEvent = call.events?.find((e) => e.type === 'user');
    const operatorExt = userEvent?.number ?? call.caller_id_number ?? null;

    // outbound: destination_number = client
    // inbound/missed: caller_id_number = client
    const clientPhone =
        call.accountcode === 'outbound'
            ? call.destination_number
            : call.caller_id_number;

    return { operatorExt, clientPhone };
}

async function syncLeadPbxChats({ pbxClient, leadId }) {
    const lead = await LeadModel.findById(leadId)
        .select('clientPhone createdAt')
        .lean();

    if (!lead?.clientPhone) return;

    const now = Math.floor(Date.now() / 1000);
    const leadCreated = Math.floor(new Date(lead.createdAt).getTime() / 1000);

    const from3Days = now - 3 * 24 * 3600;
    const from = Math.max(from3Days, leadCreated);

    const res = await pbxClient.searchCalls({
        phone_numbers: normalizePhone(lead.clientPhone),
        start_stamp_from: from,
        start_stamp_to: now,
        user_talk_time_from: 1, // gaplashilgan
        // accountcode: 'inbound', // xohlasangiz alohida qiling
    });

    const calls = (res?.data ?? [])
        .filter((c) => String(c.gateway) === COMPANY_GATEWAY);

    if (!calls.length) return;

    const ops = calls.map((c) => {
        const { operatorExt, clientPhone } = pickOperatorAndClient(c);

        const createdAt = new Date((c.start_stamp ?? now) * 1000);

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
                        Audio: {
                            duration: Number(c.user_talk_time ?? c.duration ?? 0),
                        },
                        createdBy: Number(operatorExt ?? 0), // ext raqam bo'lsa
                        message: `📞 Call recording (${c.accountcode})`, // siz istagan text
                        createdAt, // timestamps bor, lekin set qilsangiz shu vaqtga yaqin turadi
                    },
                },
                upsert: true,
            },
        };
    });

    // bulkWrite: tez
    try {
        await LeadChat.bulkWrite(ops, { ordered: false });
    } catch (e) {
        // duplicate key xatolar bo'lishi mumkin (parallel requestlarda)
        // e ni log qilsangiz bo'ladi, lekin requestni yiqitmasin
    }
}

module.exports = { syncLeadPbxChats };
