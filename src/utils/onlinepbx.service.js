'use strict';

const LeadModel = require('../models/lead-model');
const {
    pickClientPhoneFromWebhook,
    pickOperatorExtFromPayload,
    deriveLeadFields,
    loadOperatorsMap,
} = require('./onlinepbx.utils');

const { generateShortId } = require('../utils/createLead');
const b1Sl = require('../controllers/b1SL');

const COMPANY_GATEWAY = '781134774';

const ALLOWED_STATUSES = ['Active', 'Processing', 'Returned','Missed'];

const RECENT_WINDOW_DAYS = 30;
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

let OPS_CACHE = { at: 0, map: null };
const OPS_TTL_MS = 60 * 1000;

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}


function buildPhoneVariants(raw) {
    const d = digitsOnly(raw);
    if (!d) return { full: null, local: null, candidates: [] };

    // 998901234567
    if (d.startsWith('998') && d.length >= 12) {
        const full = d.slice(0, 12);
        const local = d.slice(3, 12);
        return { full, local, candidates: [full, local] };
    }

    // 901234567 (local)
    if (/^\d{9}$/.test(d)) {
        const full = `998${d}`;
        const local = d;
        return { full, local, candidates: [full, local] };
    }

    // fallback (noyob formatlar)
    const full = d.length === 12 ? d : null;
    const local = d.length >= 9 ? d.slice(-9) : null;

    const candidates = [];
    if (full) candidates.push(full);
    if (local && local !== full) candidates.push(local);

    return { full, local, candidates };
}

function getSinceDate() {
    return new Date(Date.now() - RECENT_WINDOW_MS);
}

function isCallStartEvent(event) {
    const e = String(event || '').toLowerCase();
    return e === 'call_start' || e === 'call_user_start';
}

async function getOperatorsMapCached() {
    const now = Date.now();
    if (OPS_CACHE.map && now - OPS_CACHE.at < OPS_TTL_MS) return OPS_CACHE.map;

    const map = await loadOperatorsMap();
    OPS_CACHE = { at: now, map };
    return map;
}

async function handleOnlinePbxPayload(payload) {
    try {
        // ✅ 1) gateway check
        if (payload?.gateway && String(payload.gateway) !== COMPANY_GATEWAY) {
            return { ok: true, skipped: 'wrong_gateway' };
        }

        const rawClientPhone = pickClientPhoneFromWebhook(payload);
        if (!rawClientPhone) return { ok: true, skipped: 'no_client_phone' };

        const { full: phoneFull, candidates: phoneCandidates } =
            buildPhoneVariants(rawClientPhone);

        if (!phoneCandidates.length) return { ok: true, skipped: 'bad_phone' };

        const canonicalPhone = phoneFull ?? digitsOnly(rawClientPhone);

        const now = payload?.date_iso ? new Date(payload.date_iso) : new Date();
        const since = getSinceDate();

        const raw = pickClientPhoneFromWebhook(payload);
        const d = digitsOnly(raw);

        const local9 = d.length >= 9 ? d.slice(-9) : d;
        const regex = new RegExp(`${local9}$`);

        const leadBefore = await LeadModel.findOne({
            clientPhone: { $regex: regex },
            status: { $in: ALLOWED_STATUSES },
            purchase: { $ne: true },
        }).lean();


        const isExistingLead = !!leadBefore;

        const sapRecord = await b1Sl.findOrCreateBusinessPartner(canonicalPhone);

        const cardCode = sapRecord?.cardCode || null;
        const cardName = sapRecord?.cardName || null;

        // ✅ 6) operator mapping
        const operatorExt = pickOperatorExtFromPayload(payload);
        const opsMap = await getOperatorsMapCached();
        console.log(operatorExt, opsMap)
        const slpCode =
            (operatorExt != null && operatorExt !== 0) ? (opsMap.get(operatorExt) ?? null) : null;

        const { source, status } = deriveLeadFields(payload);

        const prevUuid = leadBefore?.pbx?.last_uuid ?? null;
        const incomingUuid = payload?.uuid ?? null;

        const isNewUuid = incomingUuid && incomingUuid !== prevUuid;
        const shouldIncCallCount = isCallStartEvent(payload?.event) && isNewUuid;

        const n = isExistingLead ? null : await generateShortId('PRO');

        const filter = {
            clientPhone: { $in: phoneCandidates },
            time: { $gte: since },
            status: { $in: ALLOWED_STATUSES },
        };

        const update = {
            $setOnInsert: {
                clientPhone: canonicalPhone,
                createdAt: now,
                n: n || undefined,
                source,
                jshshir: sapRecord?.U_jshshir || null,
                idX: sapRecord?.Cellular || null,
                passportId: sapRecord?.Cellular || null,
                jshshir2: sapRecord?.U_jshshir || null,
                cardCode,
                cardName,
            },

            $set: {
                time: now,
                operator: slpCode,
                status,
                called: true,
                callTime: now,
                updatedAt: now,

                'pbx.last_uuid': incomingUuid,
                'pbx.last_event': payload?.event ?? null,
                'pbx.last_direction': payload?.direction ?? null,
                'pbx.last_date': payload?.date_iso ?? null,
                'pbx.last_gateway': payload?.gateway ?? null,
            },
        };

        if (shouldIncCallCount) {
            update.$inc = { callCount: 1 };
        }

        // ✅ 12) Execute upsert
        const lead = await LeadModel.findOneAndUpdate(filter, update, {
            upsert: true,
            new: true,
        }).lean();

        return {
            ok: true,
            leadId: String(lead._id),
            isExistingLead,
            matchedPhone: lead?.clientPhone ?? null,
        };
    } catch (err) {
        console.error('[handleOnlinePbxPayload] Error:', err);
        return { ok: false, error: err?.message || 'Unknown error' };
    }
}

module.exports = {
    handleOnlinePbxPayload,
};
