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
const { ALLOWED_STATUSES } = require('../config');
const { writeCallEventFromPBX } = require('./lead-chat-events.util');

const COMPANY_GATEWAY = '781134774';

const DEDUP_WINDOW_DAYS = 5;
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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

function buildDedupFilter({ phoneCandidates, legacyRegex }) {
    return {
        status: { $in: ALLOWED_STATUSES },
        purchase: { $ne: true },
        $or: [
            { clientPhone: { $in: phoneCandidates } },
            ...(legacyRegex ? [{ clientPhone: { $regex: legacyRegex } }] : []),
        ],
    };
}

async function handleOnlinePbxPayload(payload) {
    try {
        // 1) gateway check
        if (payload?.gateway && String(payload.gateway) !== COMPANY_GATEWAY) {
            return { ok: true, skipped: 'wrong_gateway' };
        }

        // 2) phone
        const rawClientPhone = pickClientPhoneFromWebhook(payload);
        if (!rawClientPhone) return { ok: true, skipped: 'no_client_phone' };

        const { canonical: canonicalPhone, candidates: phoneCandidates, legacyRegex } =
            buildPhoneCandidates(rawClientPhone);

        if (!canonicalPhone || !phoneCandidates.length) {
            return { ok: true, skipped: 'bad_phone' };
        }

        // 3) time window (dedup) - info uchun qaytaramiz
        const now = payload?.date_iso ? new Date(payload.date_iso) : new Date();
        const sinceDedup = getSinceDedup(now);

        const dedupFilter = buildDedupFilter({ phoneCandidates, legacyRegex });

        // ✅ leadBefore
        const leadBefore = await LeadModel.findOne(dedupFilter)
            .select(
                [
                    'pbx.last_uuid',
                    'pbx.last_counted_uuid',
                    'pbx.prev_status', // ✅ NEW
                    'cardCode',
                    'cardName',
                    'clientPhone',
                    'time',
                    'status',
                    'purchase',
                    'operator',
                    'noAnswerCount',
                    'callCount',
                ].join(' ')
            )
            .lean();

        const isExistingLead = !!leadBefore;

        // 4) SAP BP
        const sapRecord = await b1Sl.findOrCreateBusinessPartner(canonicalPhone);
        const cardCode = sapRecord?.cardCode || null;
        const cardName = sapRecord?.cardName || null;

        // 5) operator ext -> slpCode
        const operatorExtRaw = pickOperatorExtFromPayload(payload);
        const operatorExt = operatorExtRaw == null ? null : Number(String(operatorExtRaw).trim());

        const opsMap = await getOperatorsMapCached();

        const slpCode =
            Number.isFinite(operatorExt) && operatorExt !== 0 ? (opsMap.get(operatorExt) ?? null) : null;

        const { source, status: baseStatus } = deriveLeadFields(payload);

        const event = String(payload?.event || '').toLowerCase();
        const direction = String(payload?.direction || '').toLowerCase();

        const isCallEnd = event === 'call_end';
        const isOutbound = direction === 'outbound';

        const dialog = Number(payload?.dialog_duration ?? 0);
        const hasTalk = Number.isFinite(dialog) && dialog > 0;

        const prevUuid = leadBefore?.pbx?.last_uuid ?? null;
        const incomingUuid = payload?.uuid ?? null;

        const isNewUuid = incomingUuid && incomingUuid !== prevUuid;
        const shouldIncCallAttempt = isCallStartEvent(payload?.event) && isNewUuid;

        const prevCountedUuid = leadBefore?.pbx?.last_counted_uuid ?? null;
        const shouldCountEnd = isCallEnd && incomingUuid && incomingUuid !== prevCountedUuid;

        // outbound call_end & no talk => NoAnswer
        const isNoAnswerOutboundEnd = isOutbound && isCallEnd && !hasTalk;
        const shouldMoveToNoAnswer = isNoAnswerOutboundEnd;

        // ✅ NEW: call_end + talk bo'lsa — status restore (Missed/NoAnswer bo'lmasa)
        const isMissedBase = baseStatus === 'Missed';
        const shouldRestoreStatus =
            isCallEnd &&
            hasTalk &&
            shouldCountEnd &&
            !isMissedBase &&
            !isNoAnswerOutboundEnd;

        const n = isExistingLead ? null : await generateShortId('PRO');

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
                status: baseStatus,

                cardCode,
                cardName,
                clientName: cardName || null,
                operator: slpCode,
                time: now,
            },
            $set: {
                called: true,
                callTime: now,
                updatedAt: now,
                newTime: now,

                // pbx meta
                'pbx.last_uuid': incomingUuid,
                'pbx.last_event': payload?.event ?? null,
                'pbx.last_direction': payload?.direction ?? null,
                'pbx.last_date': payload?.date_iso ?? null,
                'pbx.last_gateway': payload?.gateway ?? null,
            },
        };

        // ✅ call_start bo'lganda oldingi statusni snapshot qilib qo'yamiz
        if (shouldIncCallAttempt) {
            update.$inc = update.$inc || {};
            update.$inc.callAttemptCount = 1;

            // lead bo'lsa - shu paytdagi status; bo'lmasa baseStatus/Active
            update.$set['pbx.prev_status'] = leadBefore?.status ?? baseStatus ?? 'Active';
        }

        // call_end sanog'i (faqat 1 marta)
        if (shouldCountEnd) {
            update.$inc = update.$inc || {};

            if (isNoAnswerOutboundEnd) {
                update.$inc.noAnswerCount = 1;
            }

            if (hasTalk) {
                update.$inc.callCount = 1;
                update.$set.answered = true;
            }

            update.$set['pbx.last_counted_uuid'] = incomingUuid;
        }

        // NoAnswer ketma-ket 6 bo'lsa auto-close
        if (shouldCountEnd && isNoAnswerOutboundEnd) {
            const prevNoAnswer = Number(leadBefore?.noAnswerCount ?? 0);
            const nextNoAnswer = prevNoAnswer + 1;

            const canAutoClose =
                !leadBefore?.status || leadBefore.status === 'Active' || leadBefore.status === 'NoAnswer';

            if (canAutoClose && nextNoAnswer >= 6) {
                update.$set.status = 'Closed';
                update.$set.rejectionReason = "Umuman aloqaga chiqib bo`lmadi";
                delete update.$setOnInsert.status;
            }
        }

        // NoAnswer status
        if (shouldMoveToNoAnswer) {
            update.$set.status = 'NoAnswer';
            delete update.$setOnInsert.status;
        }

        // Missed status (deriveLeadFields() bo'yicha)
        if (isMissedBase) {
            update.$set.status = 'Missed';
            delete update.$setOnInsert.status;
        }

        const shouldRestoreOnTalkEnd = isCallEnd && hasTalk && shouldCountEnd;

        if (shouldRestoreOnTalkEnd) {
            if (isExistingLead) {
                const curStatus = leadBefore?.status;

                if (curStatus === 'Missed' || curStatus === 'NoAnswer') {
                    const prevStatus = leadBefore?.pbx?.prev_status || 'Ignored';
                    update.$set.status = prevStatus;
                    delete update.$setOnInsert.status;
                }
            } else {
                update.$set.status = 'Ignored';
                delete update.$setOnInsert.status;
            }
        }

        if (sapRecord?.cardCode) {
            update.$set.cardCode = sapRecord?.cardCode;
            delete update.$setOnInsert.cardCode;
        }

        if (sapRecord?.cardName) {
            update.$set.cardName = sapRecord?.cardName;
            delete update.$setOnInsert.cardName;

            update.$set.clientName = sapRecord?.cardName;
            delete update.$setOnInsert.clientName;
        }

        if (sapRecord?.U_jshshir) {
            update.$set.jshshir = sapRecord?.U_jshshir;
            delete update.$setOnInsert.jshshir;
        }

        if (sapRecord?.Cellular) {
            update.$set.passportId = sapRecord?.Cellular;
            delete update.$setOnInsert.passportId;
        }


        if(update.$set.status){
            update.$set.statusChangedAt = now;
            recallDate
        }

        const operatorIsEmpty =
            leadBefore?.operator == null || leadBefore?.operator === '' || leadBefore?.operator === 0;

        if (operatorIsEmpty && slpCode != null) {
            update.$set.operator = slpCode;
            delete update.$setOnInsert.operator;
        }

        const lead = await LeadModel.findOneAndUpdate(dedupFilter, update, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        }).lean();

        const rawEvent = String(payload?.event || '');
        const eventLower = rawEvent.toLowerCase();
        const isMissed = eventLower.includes('missed');

        if ((isCallEnd && dialog === 0) || isMissed) {
            await writeCallEventFromPBX({
                leadId: lead._id,
                payload,
                slpCode,
                operatorExt,
                clientPhone: canonicalPhone,
                isSystem: true,
            });
        }

        return {
            ok: true,
            leadId: String(lead._id),
            isExistingLead,
            matchedPhone: lead?.clientPhone ?? null,
            dedupSince: sinceDedup,
        };
    } catch (err) {
        console.error('[handleOnlinePbxPayload] Error:', err);
        // return { ok: false, error: err?.message || 'Unknown error' };
    }
}

module.exports = {
    handleOnlinePbxPayload,
};
