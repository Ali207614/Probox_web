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


const ALLOWED_STATUSES = ['Active', 'Processing', 'Returned', 'Missed', 'Closed'];


const DEDUP_WINDOW_DAYS = 2;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;


const RECENT_WINDOW_DAYS = 30;
const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

let OPS_CACHE = { at: 0, map: null };
const OPS_TTL_MS = 60 * 1000;

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

function canonicalizePhone(raw) {
    const d = digitsOnly(raw);
    if (!d) return null;

    // local 9 -> full 998 + 9
    if (/^\d{9}$/.test(d)) return `998${d}`;

    // already full 998XXXXXXXXX (12 digits)
    if (d.startsWith('998') && d.length >= 12) return d.slice(0, 12);

    // fallback: digits
    return d;
}

function buildPhoneCandidates(raw) {
    const d = digitsOnly(raw);
    const canonical = canonicalizePhone(raw);
    const local9 = d.length >= 9 ? d.slice(-9) : null;

    const candidates = [];
    if (canonical) candidates.push(canonical);
    if (local9 && local9 !== canonical) candidates.push(local9);

    const legacyRegex = local9 ? new RegExp(`${local9}$`) : null;

    return { canonical, local9, candidates, legacyRegex };
}

function getSinceDate() {
    return new Date(Date.now() - RECENT_WINDOW_MS);
}

function getSinceDedup(now = new Date()) {
    return new Date(now.getTime() - DEDUP_WINDOW_MS);
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

/**
 * ✅ Dedup filter:
 * - oxirgi 2 kun ichida (time >= sinceDedup)
 * - status ALLOWED_STATUSES ichida
 * - purchase != true
 * - clientPhone match: candidates OR legacyRegex (local9 endsWith)
 */
function buildDedupFilter({ sinceDedup, phoneCandidates, legacyRegex }) {
    return {
        status: { $in: ALLOWED_STATUSES },
        purchase: { $ne: true },
        time: { $gte: sinceDedup },
        $or: [
            { clientPhone: { $in: phoneCandidates } },
            ...(legacyRegex ? [{ clientPhone: { $regex: legacyRegex } }] : []),
        ],
    };
}

async function handleOnlinePbxPayload(payload) {
    try {
        // ✅ 1) gateway check
        if (payload?.gateway && String(payload.gateway) !== COMPANY_GATEWAY) {
            return { ok: true, skipped: 'wrong_gateway' };
        }

        // ✅ 2) phone
        const rawClientPhone = pickClientPhoneFromWebhook(payload);
        if (!rawClientPhone) return { ok: true, skipped: 'no_client_phone' };

        const { canonical: canonicalPhone, candidates: phoneCandidates, legacyRegex } =
            buildPhoneCandidates(rawClientPhone);

        if (!canonicalPhone || !phoneCandidates.length) {
            return { ok: true, skipped: 'bad_phone' };
        }

        // ✅ 3) time window (dedup)
        const now = payload?.date_iso ? new Date(payload.date_iso) : new Date();
        const sinceDedup = getSinceDedup(now);

        // (Agar sizda boshqa joylarda 30 kunlik since ishlatilsa, qoldirdik)
        // const since30d = getSinceDate();

        // ✅ 4) Dedup: oxirgi 2 kun ichida shu statuslarda bo'lgan lead bormi?
        // MUHIM: leadBefore qidiruvi va upsert filteri BIR XIL bo'lishi shart.
        const dedupFilter = buildDedupFilter({ sinceDedup, phoneCandidates, legacyRegex });

        const leadBefore = await LeadModel.findOne(dedupFilter)
            .select('pbx.last_uuid clientPhone time status purchase')
            .lean();

        const isExistingLead = !!leadBefore;

        // ✅ 5) SAP (find or create)
        const sapRecord = await b1Sl.findOrCreateBusinessPartner(canonicalPhone);

        const cardCode = sapRecord?.cardCode || null;
        const cardName = sapRecord?.cardName || null;

        // ✅ 6) operator mapping
        const operatorExt = pickOperatorExtFromPayload(payload);
        const opsMap = await getOperatorsMapCached();
        const slpCode =
            operatorExt != null && operatorExt !== 0 ? opsMap.get(operatorExt) ?? null : null;

        // ✅ 7) lead fields
        const { source, status } = deriveLeadFields(payload);

        // ✅ 8) callCount increment logic
        const prevUuid = leadBefore?.pbx?.last_uuid ?? null;
        const incomingUuid = payload?.uuid ?? null;

        const isNewUuid = incomingUuid && incomingUuid !== prevUuid;
        const shouldIncCallCount = isCallStartEvent(payload?.event) && isNewUuid;

        // ✅ 9) n: faqat yangi lead yaratilsa
        const n = isExistingLead ? null : await generateShortId('PRO');

        // ✅ 10) Upsert filter (dedupFilter bilan aynan bir xil)
        const filter = dedupFilter;

        // ✅ 11) Update
        const update = {
            $setOnInsert: {
                clientPhone: canonicalPhone, // doim canonical saqlaymiz
                createdAt: now,
                n: n || undefined,

                source,

                jshshir: sapRecord?.U_jshshir || null,
                idX: sapRecord?.Cellular || null,
                passportId: sapRecord?.Cellular || null,
                jshshir2: sapRecord?.U_jshshir || null,

                cardCode,
                cardName,
                status,
                operator: slpCode,
            },

            $set: {
                // har safar kelganda yangilanadi
                time: now,
                called: true,
                callTime: now,
                updatedAt: now,

                // pbx meta
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
            dedupSince: sinceDedup,
        };
    } catch (err) {
        console.error('[handleOnlinePbxPayload] Error:', err);
        return { ok: false, error: err?.message || 'Unknown error' };
    }
}

module.exports = {
    handleOnlinePbxPayload,
};
