'use strict';

const LeadChatModel = require('../../models/lead-chat-model');
const LeadModel = require('../../models/lead-model');
const { buildLeadPhoneVariants } = require('../../services/lead_pbx_sync.service');

function normalizeCalls(res) {
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res)) return res;
    return [];
}

async function getCallTimeRangeByUuid({ pbxClient, trunkNames, uuid, leadPhoneLocal, leadPhoneFull }) {
    if (!pbxClient) throw new Error('pbxClient is required');
    if (!uuid) return { start: null, end: null };

    // 1) uuid bilan qidirish (agar support bo'lsa)
    try {
        const res = await pbxClient.searchCalls({
            uuid: String(uuid),
            trunk_names: trunkNames,
            sort_by: 'start_stamp',
            sort_order: 'asc',
            limit: 1,
        });

        const calls = normalizeCalls(res);
        const c = calls?.[0];
        if (c?.start_stamp) {
            const start = new Date(Number(c.start_stamp) * 1000);
            const end = c?.end_stamp ? new Date(Number(c.end_stamp) * 1000) : null;
            return { start, end };
        }
    } catch (_) {
        // uuid param support qilmasligi mumkin
    }

    // 2) fallback: phone + range ichida uuid topish
    if (!leadPhoneLocal) return { start: null, end: null };

    const nowSec = Math.floor(Date.now() / 1000);
    const LOOKBACK_DAYS = Number(process.env.GEMINI_CALL_LOOKBACK_DAYS || 30);
    const from = nowSec - LOOKBACK_DAYS * 24 * 60 * 60;

    const res2 = await pbxClient.searchCalls({
        phone_numbers: [leadPhoneFull, leadPhoneLocal].filter(Boolean).map(String),
        start_stamp_from: from,
        start_stamp_to: nowSec,
        sort_by: 'start_stamp',
        sort_order: 'asc',
        trunk_names: trunkNames,
    });

    const calls2 = normalizeCalls(res2);
    const found = calls2.find((c) => String(c?.uuid) === String(uuid)) || null;

    if (!found?.start_stamp) return { start: null, end: null };

    const start = new Date(Number(found.start_stamp) * 1000);
    const end = found?.end_stamp ? new Date(Number(found.end_stamp) * 1000) : null;
    return { start, end };
}

async function getCallTimeFromHistoryByUuid({ leadId, uuid }) {
    if (!uuid) return null;

    const ev = await LeadChatModel.findOne({
        leadId,
        isDeleted: false,
        'pbx.uuid': String(uuid),
    })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean();

    return ev?.createdAt ? new Date(ev.createdAt) : null;
}

async function getClosedAtFromHistory({ leadId, closedStatus = 'Closed' }) {
    const ev = await LeadChatModel.findOne({
        leadId,
        type: 'event',
        action: 'status_changed',
        statusTo: closedStatus,
        isDeleted: false,
    })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean();

    return ev?.createdAt ? new Date(ev.createdAt) : null;
}

async function getHistoryBetween({ leadId, from, to, limit = 80 }) {
    if (!from || !to) {
        return LeadChatModel.find({ leadId, isDeleted: false })
            .sort({ createdAt: -1 })
            .limit(15)
            .select(
                'type action message changes pbx audio createdAt statusFrom statusTo operatorFrom operatorTo createdBy createdByRole isSystem'
            )
            .lean();
    }

    return LeadChatModel.find({
        leadId,
        isDeleted: false,
        createdAt: { $gte: from, $lte: to },
    })
        .sort({ createdAt: 1 })
        .limit(limit)
        .select(
            'type action message changes pbx audio createdAt statusFrom statusTo operatorFrom operatorTo createdBy createdByRole isSystem'
        )
        .lean();
}

async function buildClosedContextWindow({
                                            pbxClient,
                                            trunkNames,
                                            leadId,
                                            uuid,
                                            closedStatus = 'Closed',
                                            bufferMin = 180,
                                            limit = 80,
                                            now = new Date(),
                                        }) {
    let audioStart = null;
    let audioEnd = null;

    // ✅ lead phone kerak (uuid -> call time fallback uchun)
    const lead = await LeadModel.findById(leadId).select('clientPhone').lean();
    const leadPhones = lead?.clientPhone ? buildLeadPhoneVariants(lead.clientPhone) : { full: null, local: null };

    // 1) PBX’dan start/end olishga harakat
    try {
        const range = await getCallTimeRangeByUuid({
            pbxClient,
            trunkNames,
            uuid,
            leadPhoneLocal: leadPhones.local || leadPhones.full,
            leadPhoneFull: leadPhones.full,
        });
        audioStart = range?.start || null;
        audioEnd = range?.end || null;
    } catch (_) {}

    // 2) fallback: LeadChat’dan uuid createdAt
    if (!audioStart) {
        try {
            audioStart = await getCallTimeFromHistoryByUuid({ leadId, uuid });
        } catch (_) {}
    }

    // 3) closedAt
    let closedAt = null;
    try {
        closedAt = await getClosedAtFromHistory({ leadId, closedStatus });
    } catch (_) {}

    if (!closedAt) closedAt = now;

    // 4) window
    const bufferMs = Number(bufferMin) * 60 * 1000;
    const from = audioStart ? new Date(audioStart.getTime() - bufferMs) : null;
    const to = closedAt ? new Date(closedAt.getTime() + bufferMs) : null;

    // 5) history
    const history = await getHistoryBetween({ leadId, from, to, limit });

    return { audioStart, audioEnd, closedAt, from, to, history };
}

module.exports = {
    buildClosedContextWindow,
};