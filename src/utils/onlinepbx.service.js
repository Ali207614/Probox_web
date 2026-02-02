const LeadModel = require('../models/lead-model');
const LeadChat = require('../models/lead-chat-model');

const {
    pickClientPhoneFromWebhook,
    pickOperatorExtFromPayload,
    deriveLeadFields,
    loadOperatorsMap,
} = require('./onlinepbx.utils');

// simple in-memory cache
let OPS_CACHE = { at: 0, map: null };
const OPS_TTL_MS = 60 * 1000;

async function getOperatorsMapCached() {
    const now = Date.now();
    if (OPS_CACHE.map && now - OPS_CACHE.at < OPS_TTL_MS) return OPS_CACHE.map;
    const map = await loadOperatorsMap();
    OPS_CACHE = { at: now, map };
    return map;
}

function isCallStartEvent(event) {
    const e = String(event || '').toLowerCase();
    return e === 'call_start' || e === 'call_user_start';
}

async function handleOnlinePbxPayload(payload) {
    const clientPhone = pickClientPhoneFromWebhook(payload);
    if (!clientPhone) {
        return { ok: true, skipped: 'no_client_phone' };
    }

    const operatorExt = pickOperatorExtFromPayload(payload);
    console.log(`[handleOnlinePbxPayload] ${clientPhone} => ${operatorExt}`);
    const opsMap = await getOperatorsMapCached();
    const slpCode = operatorExt != null ? (opsMap.get(operatorExt) ?? null) : null;

    const { source, status } = deriveLeadFields(payload);

    const now = payload.date_iso ? new Date(payload.date_iso) : new Date();
    const event = String(payload.event || '').toLowerCase();

    /**
     * callCount dedup:
     * - agar call_start/call_user_start kelgan bo'lsa va uuid yangi bo'lsa callCount++
     * - uuid yo'q bo'lsa callCount++ qilmaymiz (aks holda spam bo'ladi)
     */
    let leadBefore = null;
    if (payload.uuid) {
        leadBefore = await LeadModel.findOne({ clientPhone })
            .select('pbx callCount')
            .lean();
    }

    const prevUuid = leadBefore?.pbx?.last_uuid ?? null;
    const isNewUuid = payload.uuid && payload.uuid !== prevUuid;
    const shouldIncCallCount = isCallStartEvent(event) && isNewUuid;

    const update = {
        $setOnInsert: {
            clientPhone,
            createdAt: now,
            callCount: 0,
        },
        $set: {
            source,
            status,
            operator: slpCode,
            called: true,
            callTime: now,
            updatedAt: now,

            'pbx.last_uuid': payload.uuid ?? null,
            'pbx.last_event': payload.event ?? null,
            'pbx.last_direction': payload.direction ?? null,
            'pbx.last_date': payload.date_iso ?? null,
        },
    };

    if (shouldIncCallCount) {
        update.$inc = { callCount: 1 };
    }

    const lead = await LeadModel.findOneAndUpdate(
        { clientPhone },
        update,
        { upsert: true, new: true }
    ).lean();

    /**
     * call_end bo'lsa recording url bo'yicha LeadChat yozish (ixtiyoriy)
     */
    if (event === 'call_end' && payload.uuid) {
        const duration = Number(payload.dialog_duration ?? payload.call_duration ?? 0);

        await LeadChat.updateOne(
            { leadId: lead._id, 'pbx.uuid': payload.uuid },
            {
                $setOnInsert: {
                    leadId: lead._id,
                    pbx: {
                        uuid: payload.uuid,
                        gateway: payload.gateway ?? null,
                        accountcode: payload.direction ?? null,
                        start_stamp: null,
                        end_stamp: null,
                        operator_ext: operatorExt != null ? String(operatorExt) : null,
                        client_phone: clientPhone,
                    },
                    Audio: {
                        url: payload.download_url ?? null,
                        duration: Number.isFinite(duration) ? duration : 0,
                    },
                    operatorSlpCode: slpCode, // createdBy o'rniga alohida
                    message: `📞 Call (${payload.direction})`,
                    createdAt: now,
                },
            },
            { upsert: true }
        );
    }

    return { ok: true, leadId: String(lead._id) };
}

module.exports = {
    handleOnlinePbxPayload,
};
