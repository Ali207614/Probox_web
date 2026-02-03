const LeadModel = require('../models/lead-model');
const LeadChat = require('../models/lead-chat-model');

const {
    pickClientPhoneFromWebhook,
    pickOperatorExtFromPayload,
    deriveLeadFields,
    loadOperatorsMap,
} = require('./onlinepbx.utils');

const { generateShortId } = require('../utils/createLead');
const b1Sl = require("../controllers/b1SL");

const COMPANY_GATEWAY = '781134774';

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
    try {
        // ✅ 1) gateway check
        if (payload.gateway && String(payload.gateway) !== COMPANY_GATEWAY) {
            return { ok: true, skipped: 'wrong_gateway' };
        }

        const clientPhone = pickClientPhoneFromWebhook(payload);
        if (!clientPhone) return { ok: true, skipped: 'no_client_phone' };

        console.log(`[handleOnlinePbxPayload] ${clientPhone} ${payload.event}`);
        const sapRecord = await b1Sl.findOrCreateBusinessPartner(clientPhone);

        const cardCode = sapRecord?.cardCode || null;
        const cardName = sapRecord?.cardName || null;

        const operatorExt = pickOperatorExtFromPayload(payload);
        const opsMap = await getOperatorsMapCached();
        const slpCode = operatorExt != null ? (opsMap.get(operatorExt) ?? null) : null;

        const { source, status } = deriveLeadFields(payload);

        const now = payload.date_iso ? new Date(payload.date_iso) : new Date();
        const event = String(payload.event || '').toLowerCase();

        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        let leadBefore = null;
        if (payload.uuid) {
            leadBefore = await LeadModel.findOne({
                clientPhone,
                time: { $gte: since },
            })
                .select('pbx callCount time')
                .lean();
        }

        const prevUuid = leadBefore?.pbx?.last_uuid ?? null;

        const isNewUuid = payload.uuid && payload.uuid !== prevUuid;
        const shouldIncCallCount = isCallStartEvent(event) && isNewUuid;

        const n = await generateShortId('PRO');

        const filter = {
            clientPhone,
            time: { $gte: since },
        };

        const update = {
            $setOnInsert: {
                clientPhone,
                createdAt: now,
                time: now, // yangi lead ochilganda time qo'yiladi
                n,
                cardCode,
                cardName,
                clientName: sapRecord?.cardName || null,
                jshshir:sapRecord?.U_jshshir || null,
                idX: sapRecord?.Cellular || null,
                passportId: sapRecord?.Cellular || null,
                jshshir2: sapRecord?.U_jshshir || null,
            },
            $set: {
                source,
                status,
                operator: slpCode,
                called: true,
                callTime: now,
                updatedAt: now,

                // pbx meta
                'pbx.last_uuid': payload.uuid ?? null,
                'pbx.last_event': payload.event ?? null,
                'pbx.last_direction': payload.direction ?? null,
                'pbx.last_date': payload.date_iso ?? null,
                'pbx.last_gateway': payload.gateway ?? null,
            },
        };

        // ✅ 3) time: now faqat status active bo'lsa update bo'lsin (insertda doim bor)
        if (status === 'active') {
            update.$set.time = now;
        }

        // callCount++ (conflict bo'lmasligi uchun setOnInsertda callCount yo'q!)
        if (shouldIncCallCount) {
            update.$inc = { callCount: 1 };
        }

        const lead = await LeadModel.findOneAndUpdate(filter, update, {
            upsert: true,
            new: true,
        }).lean();

        return { ok: true, leadId: String(lead._id) };
    } catch (err) {
        console.error('[handleOnlinePbxPayload] Error:', err);
        return { ok: false, error: err.message };
    }
}

module.exports = {
    handleOnlinePbxPayload,
};
