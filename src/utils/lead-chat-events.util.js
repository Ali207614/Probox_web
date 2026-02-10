'use strict';

const LeadChat = require('../models/lead-chat-model');

function safeJson(val) {
    try {
        return JSON.stringify(val);
    } catch {
        return String(val);
    }
}

function isDifferent(a, b) {
    if (a === b) return false;
    if (a == null && b == null) return false;

    // date compare
    if (a instanceof Date || b instanceof Date) {
        const ta = a instanceof Date ? a.getTime() : new Date(a).getTime();
        const tb = b instanceof Date ? b.getTime() : new Date(b).getTime();
        return ta !== tb;
    }

    const ta = typeof a;
    const tb = typeof b;

    if (ta === 'object' || tb === 'object') {
        return safeJson(a) !== safeJson(b);
    }

    return true;
}

/**
 * ✅ buildChanges(existingLead, nextData, allowedFields?)
 * - 1 update = 1 event uchun changes[] ni yasaydi
 * - allowedFields bersangiz: faqat shularni tekshiradi
 */
function buildChanges(existingLead, nextData, allowedFields = null) {
    const changes = [];
    if (!nextData) return changes;

    const keys = Object.keys(nextData);
    for (const field of keys) {
        if (allowedFields && !allowedFields.includes(field)) continue;

        const from = existingLead ? existingLead[field] : undefined;
        const to = nextData[field];

        if (isDifferent(from, to)) {
            changes.push({
                field,
                from: from === undefined ? null : from,
                to: to === undefined ? null : to,
            });
        }
    }

    return changes;
}

function pickActor(reqUser, opts = {}) {
    if (opts.isSystem) {
        return {
            createdBy: 0,
            createdByRole: 'System',
            isSystem: true,
        };
    }

    // sizda req.user {U_role} bor edi.
    // createdBy: sizning auth struktura bo'yicha moslab oling.
    const createdBy =
        reqUser?.id ??
        reqUser?.U_id ??
        reqUser?.userId ??
        reqUser?.telegram_id ??
        null;

    return {
        createdBy: Number.isFinite(Number(createdBy)) ? Number(createdBy) : 0,
        createdByRole: reqUser?.U_role ?? reqUser?.role ?? null,
        isSystem: false,
    };
}

function hasValidUuid(uuid) {
    return uuid != null && String(uuid).trim() !== '';
}

function hasValidPbx(pbx) {
    // ✅ pbx faqat uuid haqiqiy bo'lsa yozilsin (null/"" bo'lsa DBga kirmasin)
    return pbx && typeof pbx === 'object' && hasValidUuid(pbx.uuid);
}

/**
 * ✅ writeLeadEvent
 * Universal: status change / operator change / lead updated / auto closed / note ...
 *
 * Required schema fields:
 * - createdBy (required)
 * - message (required)
 */
async function writeLeadEvent({
                                  leadId,
                                  reqUser = null,
                                  isSystem = false,

                                  // feed
                                  type = 'event', // 'chat' | 'event'
                                  action = 'lead_updated', // enum
                                  message, // required

                                  // changes & snapshots
                                  changes = [],
                                  statusFrom = null,
                                  statusTo = null,
                                  operatorFrom = null,
                                  operatorTo = null,

                                  // pbx meta (optional)
                                  pbx = null,

                                  // audio meta (optional)
                                  audio = null,
                              }) {
    if (!leadId) throw new Error('writeLeadEvent: leadId is required');
    if (!message || String(message).trim() === '') {
        throw new Error('writeLeadEvent: message is required');
    }

    const actor = pickActor(reqUser, { isSystem });

    const doc = {
        leadId,
        type,
        action,

        ...actor,

        message: String(message).trim(),

        changes: Array.isArray(changes) ? changes : [],

        statusFrom,
        statusTo,
        operatorFrom,
        operatorTo,

        // ✅ pbx faqat uuid bo'lsa yoziladi (duplicate key muammosini yo'q qiladi)
        ...(hasValidPbx(pbx) ? { pbx } : {}),
        ...(audio ? { audio } : {}),
    };

    return LeadChat.create(doc);
}

/**
 * ✅ buildUpdateEventPayload
 * - updateLead uchun: existingLead + validData dan
 * - action'ni automatik tanlaydi: status_changed/operator_changed/lead_updated
 */
function buildUpdateEventPayload({ existingLead, validData, allowedFields }) {
    const changes = buildChanges(existingLead, validData, allowedFields);

    const statusCh = changes.find((c) => c.field === 'status');
    const operatorCh = changes.find((c) => c.field === 'operator');

    const payload = {
        action: 'lead_updated',
        message: 'Lead updated',
        changes,
        statusFrom: null,
        statusTo: null,
        operatorFrom: null,
        operatorTo: null,
    };

    if (statusCh) {
        payload.action = 'status_changed';
        payload.statusFrom = statusCh.from ?? null;
        payload.statusTo = statusCh.to ?? null;
        payload.message = `Status changed: ${payload.statusFrom ?? '—'} → ${payload.statusTo ?? '—'}`;
    } else if (operatorCh) {
        payload.action = 'operator_changed';
        payload.operatorFrom = operatorCh.from ?? null;
        payload.operatorTo = operatorCh.to ?? null;
        payload.message = `Operator changed: ${payload.operatorFrom ?? '—'} → ${payload.operatorTo ?? '—'}`;
    } else if (changes.length) {
        payload.action = 'lead_updated';
        payload.message = `Lead updated (${changes.length} field${changes.length === 1 ? '' : 's'})`;
    } else {
        payload.action = 'lead_updated';
        payload.message = 'Lead updated';
    }

    return payload;
}

/**
 * ✅ PBX event’dan call outcome aniqlash
 * Sizning qoidalar:
 * - outbound + call_end + dialog_duration<=0 => no_answer
 * - call_missed event => missed
 * - inbound + call_end + duration<=0 => missed
 * - duration>0 => answered
 */
function deriveCallOutcome(payload) {
    const event = String(payload?.event || '').toLowerCase();
    const dir = String(payload?.direction || '').toLowerCase();

    const dialog = Number(payload?.dialog_duration ?? 0);
    const hasTalk = Number.isFinite(dialog) && dialog > 0;

    if (event.includes('call_missed')) return { outcome: 'missed', hasTalk: false };

    if (event === 'call_end') {
        if (hasTalk) return { outcome: 'answered', hasTalk: true };

        if (dir === 'outbound') return { outcome: 'no_answer', hasTalk: false };
        if (dir === 'inbound') return { outcome: 'missed', hasTalk: false };
    }

    return { outcome: 'unknown', hasTalk };
}

/**
 * ✅ writeCallEventFromPBX
 * - webhook’dan kelgan payload bilan event yozadi
 * - IMPORTANT: uuid bo'lmasa pbx umuman yozilmaydi (duplicate index muammosi yo'q)
 */
async function writeCallEventFromPBX({
                                         leadId,
                                         payload,
                                         slpCode = null, // operator slpCode
                                         operatorExt = null, // operator ext
                                         clientPhone = null,
                                         isSystem = true,
                                     }) {
    const event = String(payload?.event || '').toLowerCase();
    const directionRaw = String(payload?.direction || '').toLowerCase();

    const direction =
        directionRaw === 'inbound' || directionRaw === 'outbound' ? directionRaw : null;

    const { outcome } = deriveCallOutcome(payload);

    // action tanlash
    let action = 'call_ended';
    if (event === 'call_start' || event === 'call_user_start') action = 'call_started';

    if (event === 'call_end') {
        if (outcome === 'answered') action = 'call_answered';
        else if (outcome === 'no_answer') action = 'call_no_answer';
        else if (outcome === 'missed') action = 'call_missed';
        else action = 'call_ended';
    }

    if (event.includes('call_missed')) action = 'call_missed';

    const uuid = hasValidUuid(payload?.uuid) ? String(payload.uuid).trim() : null;
    const dialog = Number(payload?.dialog_duration ?? 0);

    const message = `Call ${direction || '—'}: ${action.replace('call_', '').replace('_', ' ')}`;

    // ✅ pbx faqat uuid bo'lsa yaratiladi
    const pbx =
        uuid
            ? {
                uuid,
                gateway: payload?.gateway ?? null,
                accountcode: payload?.accountcode ?? null,
                direction,

                start_stamp: payload?.start_stamp ?? null,
                end_stamp: payload?.end_stamp ?? null,

                operator_ext: operatorExt != null ? String(operatorExt) : null,
                operator_slpCode: Number.isFinite(Number(slpCode)) ? Number(slpCode) : null,

                client_phone: clientPhone ? String(clientPhone) : null,

                outcome:
                    outcome === 'answered' || outcome === 'no_answer' || outcome === 'missed'
                        ? outcome
                        : 'unknown',
                dialog_duration: Number.isFinite(dialog) ? dialog : null,
            }
            : null;

    return writeLeadEvent({
        leadId,
        reqUser: null,
        isSystem,

        type: 'event',
        action,
        message,

        // ✅ uuid bo'lmasa pbx umuman DBga kirmaydi
        ...(pbx ? { pbx } : {}),
        changes: [],
    });
}

module.exports = {
    buildChanges,
    writeLeadEvent,
    buildUpdateEventPayload,
    deriveCallOutcome,
    writeCallEventFromPBX,
};
