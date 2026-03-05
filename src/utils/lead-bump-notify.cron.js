'use strict';

const cron = require('node-cron');

const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');
const User = require('../models/user-model');
const bot = require('../bot');

const {
    TZ,
    CRON_INTERVAL,
    TARGET_STATUSES,
    NO_PURCHASE_STATUS,
    CLOSED_STATUS,
    STATUS_LABELS,
} = require('../constants/lead-bump-notify.constants');

const {
    QA_GROUP_CHAT_ID,
    escapeHtml,
    isWithinWorkingHours,
    buildLeadLink,
    buildMentionTag,
} = require('./lead-bump-notify.helpers');

const { getGeminiClosedAnalysisLine } = require('../services/closed-gemini.service');
const {Types} = require("mongoose");

const NOTIFY_DELAY_MS = 10 * 60 * 1000;
const ESCALATE_DELAY_MS = 10 * 60 * 1000;

const NO_PURCHASE_DELAY_MS = Number(process.env.NO_PURCHASE_DELAY_MS || 10 * 60 * 1000);
const NO_PURCHASE_BATCH_SIZE = Number(process.env.NO_PURCHASE_BATCH_SIZE || 30);

const CLOSED_DELAY_MS = Number(process.env.CLOSED_DELAY_MS || 10 * 60 * 1000);
const CLOSED_BATCH_SIZE = Number(process.env.CLOSED_BATCH_SIZE || 5);

const NOTIFY_BATCH_SIZE = Number(process.env.BUMP_NOTIFY_BATCH_SIZE || 30);
const ESCALATE_BATCH_SIZE = Number(process.env.BUMP_ESCALATE_BATCH_SIZE || 30);

const BUMP_MIN_DATE = new Date(process.env.BUMP_MIN_DATE_NOTIFY || '2026-03-01T00:00:00+05:00');

// ---- helpers
async function sendTelegramMessage(chatId, text) {
    if (!chatId) return false;
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        return true;
    } catch (err) {
        console.error(`[CRON:bump-notify] TG send error (chat_id=${chatId}):`, err?.message || err);
        return false;
    }
}

function buildNotifyChatEvent(lead, now, stage) {
    const stageLabel =
        stage === 'escalate'
            ? "Bo'lim boshlig'iga escalation"
            : stage === 'no_purchase_escalate'
                ? "Nazoratchiga escalation (Xarid bo'lmadi)"
                : stage === 'closed_escalate'
                    ? "Nazoratchiga escalation (Yopilgan)"
                    : 'Operatorga eslatma';

    const fieldName =
        stage === 'no_purchase_escalate'
            ? 'noPurchaseEscalatedAt'
            : stage === 'closed_escalate'
                ? 'closedEscalatedAt'
                : stage === 'escalate'
                    ? 'bumpEscalatedAt'
                    : 'bumpNotifiedAt';

    return {
        leadId: lead._id,
        type: 'event',
        isSystem: true,
        action: 'field_changed',
        createdBy: 0,
        message: `Tizim: ${stageLabel} jo'natildi.`,
        changes: [{ field: fieldName, from: null, to: now }],
        createdAt: now,
        updatedAt: now,
    };
}

async function insertHistory(chatEvents) {
    if (!chatEvents.length) return;
    try {
        await LeadChatModel.insertMany(chatEvents, { ordered: false });
    } catch (err) {
        console.error('[CRON:bump-notify] history insert error:', err?.message || err);
    }
}

// ---- operator cache
const OPS_CACHE_TTL_MS = Number(process.env.OPS_CACHE_TTL_MS || 5 * 60 * 1000);
let OPS_CACHE = { at: 0, slpCodes: [], opMap: new Map() };

async function getActiveOperatorsCached(force = false) {
    const now = Date.now();

    if (!force && OPS_CACHE.slpCodes.length && now - OPS_CACHE.at < OPS_CACHE_TTL_MS) {
        return { slpCodes: OPS_CACHE.slpCodes, opMap: OPS_CACHE.opMap, fromCache: true };
    }

    const rows = await User.find({
        slpCode: { $ne: null },
        chat_id: { $ne: null },
    })
        .select('slpCode chat_id fullName slpBranch slpRole')
        .lean();

    console.log('[CRON:bump-notify] active operators:', rows.length);

    const opMap = new Map();
    for (const u of rows) opMap.set(Number(u.slpCode), u);

    const slpCodes = [...opMap.keys()];

    OPS_CACHE = { at: now, slpCodes, opMap };
    return { slpCodes, opMap, fromCache: false };
}

// ---- Stage 1
async function processNotifyStage(now) {
    const { slpCodes, opMap } = await getActiveOperatorsCached();
    if (!slpCodes.length) return 0;

    const cutoff = new Date(now.getTime() - NOTIFY_DELAY_MS);

    const filter = {
        status: { $in: TARGET_STATUSES },
        consideringBumped: true,
        consideringBumpedAt: { $ne: null, $gte: BUMP_MIN_DATE, $lte: cutoff },
        operator: { $in: slpCodes },
        $or: [{ bumpNotifiedAt: { $exists: false } }, { bumpNotifiedAt: null }],
    };

    const leads = await LeadModel.find(filter)
        .sort({ consideringBumpedAt: -1, _id: -1 })
        .limit(NOTIFY_BATCH_SIZE)
        .select('_id n status operator clientName clientPhone consideringBumpedAt recallDate')
        .lean();

    if (!leads.length) return 0;

    let notified = 0;
    const chatEvents = [];
    const idsToUpdate = [];

    for (const lead of leads) {
        const operatorUser = opMap.get(Number(lead.operator)) || null;
        if (!operatorUser?.chat_id) continue;

        const statusLabel = STATUS_LABELS[lead.status] || lead.status;
        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";

        const text =
            `⚠️ <b>Eslatma!</b>\n\n` +
            `<b>${escapeHtml(statusLabel)}</b> uchun kelgan lead ${NOTIFY_DELAY_MS / 60000} daqiqa ichida ishlanmadi.\n\n` +
            `👤 Mijoz: <b>${escapeHtml(clientInfo)}</b>\n` +
            `📋 Lead: <a href="${link}">${escapeHtml(lead.n || lead._id)}</a>\n\n` +
            `Iltimos, tezroq aloqaga chiqing!`;

        const sent = await sendTelegramMessage(operatorUser.chat_id, text);
        if (sent) {
            notified++;
            idsToUpdate.push(lead._id);
            chatEvents.push(buildNotifyChatEvent(lead, now, 'notify'));
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            {
                _id: { $in: idsToUpdate },
                consideringBumped: true,
                operator: { $in: slpCodes },
                $or: [{ bumpNotifiedAt: { $exists: false } }, { bumpNotifiedAt: null }],
            },
            { $set: { bumpNotifiedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return notified;
}

// ---- Stage 2
async function processEscalateStage(now) {
    const { slpCodes, opMap } = await getActiveOperatorsCached();
    if (!slpCodes.length) return 0;

    const cutoff = new Date(now.getTime() - ESCALATE_DELAY_MS);

    const filter = {
        status: { $in: TARGET_STATUSES },
        consideringBumped: true,
        consideringBumpedAt: { $gte: BUMP_MIN_DATE },
        operator: { $in: slpCodes },
        bumpNotifiedAt: { $ne: null, $lte: cutoff },
        $or: [{ bumpEscalatedAt: { $exists: false } }, { bumpEscalatedAt: null }],
    };

    const leads = await LeadModel.find(filter)
        .sort({ bumpNotifiedAt: -1, _id: -1 })
        .limit(ESCALATE_BATCH_SIZE)
        .select('_id n status operator clientName clientPhone consideringBumpedAt bumpNotifiedAt recallDate')
        .lean();

    if (!leads.length) return 0;

    let escalated = 0;
    const chatEvents = [];
    const idsToUpdate = [];
    const mentionTag = buildMentionTag();

    for (const lead of leads) {
        const operatorUser = opMap.get(Number(lead.operator)) || null;
        const operatorName = operatorUser?.fullName || `SlpCode: ${lead.operator}`;

        const statusLabel = STATUS_LABELS[lead.status] || lead.status;
        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";

        const escalationText =
            `🚨 <b>Escalation!</b>\n\n` +
            `${mentionTag}, <b>${escapeHtml(operatorName)}</b> — <b>${escapeHtml(statusLabel)}</b> uchun kelgan leadga qayta aloqaga chiqmadi.\n\n` +
            `👤 Mijoz: <b>${escapeHtml(clientInfo)}</b>\n` +
            `📋 Lead: <a href="${link}">${escapeHtml(lead.n || lead._id)}</a>\n\n` +
            `Iltimos, chora ko'ring!`;

        const warningText =
            `🚨 <b>Ogohlantirish!</b>\n\n` +
            `Siz <b>${escapeHtml(statusLabel)}</b> leadga ${(NOTIFY_DELAY_MS + ESCALATE_DELAY_MS) / 60000} daqiqa ichida aloqaga chiqmadingiz.\n` +
            `Bu holat nazoratga yuborildi.\n\n` +
            `👤 Mijoz: <b>${escapeHtml(clientInfo)}</b>\n` +
            `📋 Lead: <a href="${link}">${escapeHtml(lead.n || lead._id)}</a>`;

        let sentToGroup = false;
        if (QA_GROUP_CHAT_ID) {
            sentToGroup = await sendTelegramMessage(QA_GROUP_CHAT_ID, escalationText);
            if (sentToGroup) escalated++;
        }

        if (operatorUser?.chat_id) {
            await sendTelegramMessage(operatorUser.chat_id, warningText);
        }

        if (sentToGroup) {
            idsToUpdate.push(lead._id);
            chatEvents.push(buildNotifyChatEvent(lead, now, 'escalate'));
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            {
                _id: { $in: idsToUpdate },
                consideringBumped: true,
                operator: { $in: slpCodes },
                $or: [{ bumpEscalatedAt: { $exists: false } }, { bumpEscalatedAt: null }],
            },
            { $set: { bumpEscalatedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return escalated;
}

// ---- NoPurchase -> nazorat
async function processNoPurchaseEscalation(now) {
    if (!QA_GROUP_CHAT_ID) return 0;

    const { slpCodes, opMap } = await getActiveOperatorsCached();
    if (!slpCodes.length) return 0;

    const cutoff = new Date(now.getTime() - NO_PURCHASE_DELAY_MS);

    const filter = {
        status: NO_PURCHASE_STATUS,
        consideringBumped: true,
        consideringBumpedAt: { $ne: null, $gte: BUMP_MIN_DATE, $lte: cutoff },
        operator: { $in: slpCodes },
        $or: [{ noPurchaseEscalatedAt: { $exists: false } }, { noPurchaseEscalatedAt: null }],
    };

    const leads = await LeadModel.find(filter)
        .sort({ consideringBumpedAt: -1, _id: -1 })
        .limit(NO_PURCHASE_BATCH_SIZE)
        .select('_id n status operator clientName clientPhone consideringBumpedAt')
        .lean();

    if (!leads.length) return 0;

    let escalated = 0;
    const chatEvents = [];
    const idsToUpdate = [];
    const mentionTag = buildMentionTag();

    for (const lead of leads) {
        const operatorUser = opMap.get(Number(lead.operator)) || null;
        const operatorName = operatorUser?.fullName || `SlpCode: ${lead.operator}`;

        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";

        const text =
            `🚨 <b>Xarid bo'lmadi — Nazorat!</b>\n\n` +
            `${mentionTag}, <b>${escapeHtml(operatorName)}</b> — lead <b>"Xarid bo'lmadi"</b> statusiga o'tkazildi va ${NO_PURCHASE_DELAY_MS / 60000} daqiqa ichida ishlanmadi.\n\n` +
            `👤 Mijoz: <b>${escapeHtml(clientInfo)}</b>\n` +
            `📋 Lead: <a href="${link}">${escapeHtml(lead.n || lead._id)}</a>\n\n` +
            `Iltimos, sababini aniqlang!`;

        const sent = await sendTelegramMessage(QA_GROUP_CHAT_ID, text);
        if (sent) {
            escalated++;
            idsToUpdate.push(lead._id);
            chatEvents.push(buildNotifyChatEvent(lead, now, 'no_purchase_escalate'));
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            { _id: { $in: idsToUpdate } },
            { $set: { noPurchaseEscalatedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return escalated;
}

// ---- Closed -> nazorat + Gemini
async function processClosedEscalation(now, { pbxClient, trunkName }) {
    if (!QA_GROUP_CHAT_ID) return 0;

    const { opMap } = await getActiveOperatorsCached(); // operatorName uchun
    const cutoff = new Date(now.getTime() - CLOSED_DELAY_MS);

    const baseTimeMatch = {
        $or: [
            { newTime: { $ne: null, $exists: true, $gte: BUMP_MIN_DATE, $lte: cutoff } },
            {
                $and: [
                    { $or: [{ newTime: { $exists: false } }, { newTime: null }] },
                    { time: { $ne: null, $exists: true, $gte: BUMP_MIN_DATE, $lte: cutoff } },
                ],
            },
        ],
    };

    const filter = {
        status: CLOSED_STATUS,
        $and: [
            baseTimeMatch,
            { $or: [{ closedEscalatedAt: { $exists: false } }, { closedEscalatedAt: null }] },
        ],
    };

    const leads = await LeadModel.aggregate([
        { $match: filter },
        { $addFields: { baseTime: { $ifNull: ['$newTime', '$time'] } } },
        { $sort: { baseTime: -1, _id: -1 } },
        { $limit: CLOSED_BATCH_SIZE },
        {
            $project: {
                _id: 1,
                n: 1,
                status: 1,
                operator: 1,
                clientName: 1,
                clientPhone: 1,
                newTime: 1,
                time: 1,
                baseTime: 1,
                rejectionReason: 1,
                rejectionReason2: 1,
            },
        },
    ]);

    if (!leads.length) return 0;
    console.log('[CRON:bump-notify] closed leads:', leads.length);
    let escalated = 0;
    const chatEvents = [];
    const idsToUpdate = [];
    const mentionTag = buildMentionTag();

    // Concurrency limit (oddiy)
    const concurrency = Number(process.env.GEMINI_CONCURRENCY || 2);
    console.log('[CRON:bump-notify] concurrency:', concurrency);
    let idx = 0;

    async function worker() {
        while (idx < leads.length) {
            const i = idx++;
            const lead = leads[i];

            const operatorUser = opMap.get(Number(lead.operator)) || null;
            const operatorName = operatorUser?.fullName || `SlpCode: ${lead.operator}`;

            const link = buildLeadLink(lead._id);
            const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";

            const baseTime = lead.baseTime || lead.newTime || lead.time;

            const reason =
                (lead.rejectionReason2 && String(lead.rejectionReason2).trim()) ||
                (lead.rejectionReason && String(lead.rejectionReason).trim()) ||
                '';

            const reasonLine = reason ? `🧾 Sabab: <b>${escapeHtml(reason)}</b>\n` : '';

            // ✅ GEMINI line
            let geminiLine = '';
            try {
                geminiLine = await getGeminiClosedAnalysisLine({
                    pbxClient,
                    trunkName,
                    leadId: lead._id,
                    reason,
                });
            } catch (e) {
                geminiLine = `🤖 GEMINI: analiz xatolik (${escapeHtml(e?.message || 'unknown')})`;
            }

            const text =
                `❗️ <b>Sifatsiz lead — Nazorat!</b>\n\n` +
                `${mentionTag}, <b>${escapeHtml(operatorName)}</b> — lead <b>"Yopilgan"</b> statusiga o'tkazildi\n\n` +
                `👤 Mijoz: <b>${escapeHtml(clientInfo)}</b>\n` +
                `📋 Lead: <a href="${link}">${escapeHtml(lead.n || lead._id)}</a>\n` +
                `⏱ Tayanch vaqt: ${baseTime ? new Date(baseTime).toLocaleString('uz-UZ', { timeZone: TZ }) : '—'}\n` +
                reasonLine +
                `\n${geminiLine}\n\n` +
                `Iltimos, sababini aniqlang!`;

            const sent = await sendTelegramMessage(QA_GROUP_CHAT_ID, text);
            if (sent) {
                escalated++;
                idsToUpdate.push(lead._id);
                chatEvents.push(buildNotifyChatEvent(lead, now, 'closed_escalate'));
            }
        }
    }

    // start workers
    const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
    await Promise.all(workers);

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            { _id: { $in: idsToUpdate } },
            { $set: { closedEscalatedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return escalated;
}

function startLeadBumpNotifyCron({ pbxClient, trunkName }) {
    cron.schedule(
        CRON_INTERVAL,
        async () => {
            const now = new Date();

            if (!isWithinWorkingHours(now)) return;

            try {
                const notified = await processNotifyStage(now);
                const escalated = await processEscalateStage(now);
                const noPurchase = await processNoPurchaseEscalation(now);
                const closed = await processClosedEscalation(now, { pbxClient, trunkName });

                console.log(
                    `[CRON:bump-notify] done | now=${now.toISOString()} notified=${notified} escalated=${escalated} noPurchase=${noPurchase} closed=${closed}`
                );
            } catch (err) {
                console.error('[CRON:bump-notify] error:', err?.message || err);
            }
        },
        { timezone: TZ }
    );
}

module.exports = {
    startLeadBumpNotifyCron,
    processClosedEscalation
};