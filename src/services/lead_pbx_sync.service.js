// lead_pbx_sync.service.js
const LeadChat = require('../models/lead-chat-model');
const LeadModel = require('../models/lead-model');

const COMPANY_GATEWAY = '781134774';

function normalizePhone(p = '') {
    // + qolsin (agar sizga + kerak bo'lmasa, faqat digit qiling)
    return String(p).replace(/[^\d+]/g, '');
}

function pickOperatorAndClient(call) {
    const userEvent = call.events?.find((e) => e.type === 'user');

    // operator ext: event user.number yoki fallback caller_id_number (ba'zan ext)
    const operatorExt = userEvent?.number ?? call.caller_id_number ?? null;

    // client phone: outbound => destination, inbound/missed/local => caller (odatda)
    // (inbound/outbound ikkalasini olamiz, local bo'lsa ham lead raqami qatnashsa kiradi)
    const clientPhone =
        call.accountcode === 'outbound'
            ? call.destination_number
            : call.caller_id_number;

    return { operatorExt, clientPhone };
}

function isLeadPhoneInCall(call, leadPhoneNorm) {
    const a = normalizePhone(call?.caller_id_number ?? '');
    const b = normalizePhone(call?.destination_number ?? '');
    return a === leadPhoneNorm || b === leadPhoneNorm;
}

async function syncLeadPbxChats({ pbxClient, leadId }) {
    const lead = await LeadModel.findById(leadId)
        .select('clientPhone createdAt')
        .lean();

    const leadPhone = normalizePhone(lead?.clientPhone ?? '');
    if (!leadPhone) return;

    const now = Math.floor(Date.now() / 1000);
    const leadCreated = Math.floor(new Date(lead.createdAt).getTime() / 1000);

    // ✅ 3 kun + lead yaratilgan sanadan keyin
    const from3Days = now - 3 * 24 * 3600;
    const from = Math.max(from3Days, leadCreated);

    // ✅ inbound+outbound ikkalasi ham keladi (accountcode bermaymiz)
    // ✅ faqat gaplashilgan: user_talk_time_from=1
    const res = await pbxClient.searchCalls({
        phone_numbers: leadPhone,        // to'liq match
        start_stamp_from: from,
        start_stamp_to: now,
        user_talk_time_from: 1,
    });

    // ✅ gateway filter + lead raqami haqiqatan qatnashganini qayta tekshirish
    const calls = (res?.data ?? [])
        .filter((c) => String(c.gateway) === COMPANY_GATEWAY)
        .filter((c) => isLeadPhoneInCall(c, leadPhone));

    if (!calls.length) return;

    const ops = calls.map((c) => {
        const { operatorExt, clientPhone } = pickOperatorAndClient(c);

        const createdAt = new Date((c.start_stamp ?? now) * 1000);
        const duration = Number(c.user_talk_time ?? c.duration ?? 0);

        // operator ext raqam bo'lmasa 0 qilib yubormaymiz (null bo'lsin)
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
                            accountcode: c.accountcode, // inbound/outbound/local...
                            start_stamp: c.start_stamp,
                            end_stamp: c.end_stamp,
                            operator_ext: operatorExt ? String(operatorExt) : null,
                            client_phone: clientPhone ? String(clientPhone) : null,
                        },

                        // DB'da url saqlamaymiz (CORS + expire muammosi)
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
        // parallel sync bo'lsa duplicate key bo'lishi mumkin — requestni yiqitmang
    }
}

module.exports = { syncLeadPbxChats };
