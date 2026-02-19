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

function buildLoosePhoneRegexFromLocal9(local9) {
    if (!local9) return null;
    const pat = local9.split('').join('\\D*');
    return new RegExp(pat);
}


async function getOperatorsMapCached() {
    const now = Date.now();
    if (OPS_CACHE.map && now - OPS_CACHE.at < OPS_TTL_MS) return OPS_CACHE.map;

    const map = await loadOperatorsMap();
    OPS_CACHE = { at: now, map };
    return map;
}

function buildDedupFilter({ phoneCandidates, legacyRegex, local9 }) {
    const loose = buildLoosePhoneRegexFromLocal9(local9);

    return {
        status: { $in: ALLOWED_STATUSES },
        $or: [
            { clientPhone: { $in: phoneCandidates } },                  // "998500103850" / "500103850"
            ...(legacyRegex ? [{ clientPhone: { $regex: legacyRegex } }] : []), // endsWith
            ...(loose ? [{ clientPhone: { $regex: loose } }] : []),      // "+998 50 010..."
        ],
    };
}


async function handleOnlinePbxPayload(payload , io) {
    try {
        // 1) gateway check

        if (payload?.gateway && String(payload.gateway) !== COMPANY_GATEWAY) {
            return { ok: true, skipped: 'wrong_gateway' };
        }

        const rawClientPhone = pickClientPhoneFromWebhook(payload);
        if (!rawClientPhone) return { ok: true, skipped: 'no_client_phone' };

        const { canonical: canonicalPhone,local9, candidates: phoneCandidates, legacyRegex } =
            buildPhoneCandidates(rawClientPhone);

        if (!canonicalPhone || !phoneCandidates.length) {
            return { ok: true, skipped: 'bad_phone' };
        }

        const now = payload?.date_iso ? new Date(payload.date_iso) : new Date();

        const dedupFilter = buildDedupFilter({ phoneCandidates: phoneCandidates, legacyRegex, local9 });

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

        const n = isExistingLead ? null : await generateShortId('PRO');
        function digitsOnly(v = '') {
            return String(v ?? '').replace(/\D/g, '');
        }


        let normalizedPhone = digitsOnly(rawClientPhone);
        if (normalizedPhone.length === 9) normalizedPhone = `998${normalizedPhone}`;
        if (normalizedPhone.startsWith('998') && normalizedPhone.length > 12) normalizedPhone = normalizedPhone.slice(0, 12);
        normalizedPhone = normalizedPhone || canonicalPhone;


        const update = {
            $setOnInsert: {
                clientPhone: normalizedPhone,
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
                time: now,
            },
            $set: {
                called: true,
                callTime: now,
                updatedAt: now,
                newTime: now,
                consideringBumped: false,
                consideringBumpedAt: null,
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
            update.$inc.callCount = 1;

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
                update.$set.answered = true;
            }

            update.$set['pbx.last_counted_uuid'] = incomingUuid;
        }

        if (shouldCountEnd && isNoAnswerOutboundEnd) {
            const prevNoAnswer = Number(leadBefore?.noAnswerCount ?? 0);
            const nextNoAnswer = prevNoAnswer + 1;

            if (nextNoAnswer >= 6) {
                update.$set.status = 'Closed';
                update.$set.rejectionReason = "Umuman aloqaga chiqib bo`lmadi";
                delete update.$setOnInsert.status;
            }
        }

        // NoAnswer status
        if (shouldMoveToNoAnswer && (leadBefore?.status === 'Active' || leadBefore?.status === 'Ignored')) {
            update.$set.status = 'NoAnswer';
            delete update.$setOnInsert.status;
        }

        // Missed status (deriveLeadFields() bo'yicha)
        if (isMissedBase) {
            update.$set.status = 'Missed';
            delete update.$setOnInsert.status;
        }


        if (isCallEnd && hasTalk) {
            if (isExistingLead) {
                const curStatus = leadBefore?.status;
                 if (curStatus === 'Missed' || curStatus === 'NoAnswer') {
                    update.$set.status = 'Ignored';
                    delete update.$setOnInsert.status;
                 }
                else if(curStatus === 'Active'){
                    update.$set.status = 'Ignored';
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
        }

        if (shouldCountEnd && hasTalk) {
            update.$set.talkedFlag = true;
            update.$set.talkedAt = now;
        }

        const isInbound = direction === 'inbound';
        const isNewLead = !isExistingLead;

        const leadHasOperator =
            leadBefore?.operator != null &&
            leadBefore?.operator !== '' &&
            Number(leadBefore?.operator) !== 0;

        const shouldSetInboundOperatorForNewLead =
            isInbound  && isCallEnd && hasTalk && slpCode != null;

        const shouldSetOutboundOperatorForNewLead =
            isOutbound && isNewLead && shouldIncCallAttempt && slpCode != null;

        if (!leadHasOperator) {
            if (shouldSetInboundOperatorForNewLead || shouldSetOutboundOperatorForNewLead) {
                update.$set.operator = slpCode;
                delete update.$setOnInsert.operator;
            }
        }

        const isAnsweredEvent =
            event === 'call_answered';

        const shouldMarkAnswered = isAnsweredEvent || (event === 'call_end' && hasTalk);

        const prevAnsweredUuid = leadBefore?.pbx?.last_answered_uuid ?? null;

        const shouldEmitAnsweredSocket = shouldMarkAnswered && incomingUuid && incomingUuid !== prevAnsweredUuid;

        if (shouldEmitAnsweredSocket) {
            update.$set['pbx.last_answered_uuid'] = incomingUuid;
            update.$set.answered = true;
            update.$set.answeredAt = now;
        }


        const res = await LeadModel.findOneAndUpdate(dedupFilter, update, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
            includeResultMetadata: true,
        }).lean();

        const lead = res.value;
        const wasInserted = res?.lastErrorObject?.updatedExisting === false;

        if (io && shouldEmitAnsweredSocket) {
            io.emit('pbx_answered', {
                leadId: String(lead._id),
                uuid: incomingUuid,
                clientPhone: lead.clientPhone,            // yoki canonicalPhone
                direction,
                dialogDuration: dialog,
                SlpCode: slpCode || lead?.operator || null,
                operatorExt,
                at: now.toISOString(),
                isNewLead: wasInserted,
            });
        }

        if (io && wasInserted) {
            io.emit('new_leads', {
                ...lead,
                SlpCode: lead.seller || lead.operator,
            });
        }
        const rawEvent = String(payload?.event || '');
        const eventLower = rawEvent.toLowerCase();
        const isMissed = eventLower.includes('missed');

        const shouldWriteNewLeadEvent = wasInserted; // ✅ yangi lead bo'lsa
        const shouldWriteNoAnswerOrMissed = (isCallEnd && dialog === 0) || isMissed;

        if (shouldWriteNewLeadEvent || shouldWriteNoAnswerOrMissed) {
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
        };
    } catch (err) {
        console.error('[handleOnlinePbxPayload] Error:', err);
        // return { ok: false, error: err?.message || 'Unknown error' };
    }
}

module.exports = {
    handleOnlinePbxPayload,
};
