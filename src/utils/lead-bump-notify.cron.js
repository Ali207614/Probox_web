'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');
const User = require('../models/user-model');
const bot = require('../bot');

const TZ = 'Asia/Tashkent';
const CRON_INTERVAL = '*/2 * * * *'; // har 2 daqiqada tekshiradi

const NOTIFY_DELAY_MS = 10 * 60 * 1000; // 10 daqiqa — operatorga eslatma
const ESCALATE_DELAY_MS = 10 * 60 * 1000; // yana 10 daqiqa — escalation

const TARGET_STATUSES = ['FollowUp', 'Considering', 'WillVisitStore', 'WillSendPassport'];

// ─── NoPurchase sozlamalari ─────────────────────────────────────────────────
const NO_PURCHASE_STATUS = 'NoPurchase';
const NO_PURCHASE_DELAY_MS = Number(process.env.NO_PURCHASE_DELAY_MS || 10 * 60 * 1000); // 10 daqiqa
const NO_PURCHASE_BATCH_SIZE = Number(process.env.NO_PURCHASE_BATCH_SIZE || 30);

const CLOSED_STATUS = 'Closed';
const CLOSED_DELAY_MS = Number(process.env.CLOSED_DELAY_MS || 10 * 60 * 1000);
const CLOSED_BATCH_SIZE = Number(process.env.CLOSED_BATCH_SIZE || 30);

const QA_GROUP_CHAT_ID = process.env.QA_GROUP_CHAT_ID || null;
const LEAD_LINK_BASE = process.env.LEAD_LINK_BASE || 'https://yourdomain.com/leads';

// ─── Escalation mention (guruhda tag qilinadigan odam) ──────────────────────
const QA_MENTION_USER_ID = process.env.QA_MENTION_USER_ID || null;
const QA_MENTION_NAME = process.env.QA_MENTION_NAME || 'Aloqa markazi';

// Batch size
const NOTIFY_BATCH_SIZE = Number(process.env.BUMP_NOTIFY_BATCH_SIZE || 30);
const ESCALATE_BATCH_SIZE = Number(process.env.BUMP_ESCALATE_BATCH_SIZE || 30);

// ✅ Faqat shu sanadan boshlab yaratilgan leadlar ishlanadi
const BUMP_MIN_DATE = new Date(process.env.BUMP_MIN_DATE_NOTIFY || '2026-03-01T00:00:00+05:00');

// ─── Ish vaqti cheklovi ─────────────────────────────────────────────────────
const WORK_HOUR_START = Number(process.env.WORK_HOUR_START || 9);  // 09:00
const WORK_HOUR_END = Number(process.env.WORK_HOUR_END || 21);     // 21:00

// Status label
const STATUS_LABELS = {
    FollowUp: 'Qayta aloqa',
    Considering: "O'ylab ko'radi",
    WillVisitStore: "Do'konga boradi",
    WillSendPassport: 'Passport yuboradi',
    NoPurchase: "Xarid bo'lmadi",
    Closed: 'Yopilgan',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isWithinWorkingHours(date) {
    const hour = new Date(date.toLocaleString('en-US', { timeZone: TZ })).getHours();
    return hour >= WORK_HOUR_START && hour < WORK_HOUR_END;
}

function buildLeadLink(leadId) {
    return `${LEAD_LINK_BASE}/${leadId}`;
}

/**
 * Guruhda mention qilish uchun HTML tag yasaydi.
 * Agar QA_MENTION_USER_ID berilgan bo'lsa — tg://user?id=... formatida,
 * aks holda oddiy text.
 */
function buildMentionTag() {
    if (QA_MENTION_USER_ID) {
        return `<a href="tg://user?id=${QA_MENTION_USER_ID}">${QA_MENTION_NAME}</a>`;
    }
    return QA_MENTION_NAME;
}

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

/**
 * ✅ Faqat ulangan operatorlar (slpCode + chat_id bor) ro'yxatini olamiz
 */
const OPS_CACHE_TTL_MS = Number(process.env.OPS_CACHE_TTL_MS || 5 * 60 * 1000); // 5 min
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

    const opMap = new Map();
    for (const u of rows) opMap.set(Number(u.slpCode), u);

    const slpCodes = [...opMap.keys()];

    OPS_CACHE = { at: now, slpCodes, opMap };
    return { slpCodes, opMap, fromCache: false };
}

// ─── History ────────────────────────────────────────────────────────────────

function buildNotifyChatEvent(lead, now, stage) {
    const stageLabel = stage === 'escalate'
        ? "Bo'lim boshlig'iga escalation"
        : stage === 'no_purchase_escalate'
            ? "Nazoratchiga escalation (Xarid bo'lmadi)"
            : stage === 'closed_escalate'
                ? "Nazoratchiga escalation (Yopilgan)"
                : 'Operatorga eslatma';

    const fieldName = stage === 'no_purchase_escalate'
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
        message: `Tizim: ${stageLabel} jo'natildi — operator ${NOTIFY_DELAY_MS / 60000} daqiqa ichida aloqaga chiqmadi.`,
        changes: [
            {
                field: fieldName,
                from: null,
                to: now,
            },
        ],
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

// ─── Stage 1: Operatorga eslatma (10 daq) ───────────────────────────────────

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
            `<b>${statusLabel}</b> uchun kelgan lead ${NOTIFY_DELAY_MS / 60000} daqiqa ichida ishlanmadi.\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n\n` +
            `Iltimos, tezroq aloqaga chiqing!`;

        const sent = await sendTelegramMessage(operatorUser.chat_id, text);

        // ✅ Faqat muvaffaqiyatli yuborilgandagina update va history yoziladi
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

// ─── Stage 2: Escalation (20 daq) ───────────────────────────────────────────

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
            `${mentionTag}, <b>${operatorName}</b> — <b>${statusLabel}</b> uchun kelgan leadga qayta aloqaga chiqmadi.\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n` +
            `⏱ Bump vaqti: ${
                lead.consideringBumpedAt
                    ? new Date(lead.consideringBumpedAt).toLocaleString('uz-UZ', { timeZone: TZ })
                    : '—'
            }\n\n` +
            `Iltimos, chora ko'ring!`;

        const warningText =
            `🚨 <b>Ogohlantirish!</b>\n\n` +
            `Siz <b>${statusLabel}</b> leadga ${(NOTIFY_DELAY_MS + ESCALATE_DELAY_MS) / 60000} daqiqa ichida aloqaga chiqmadingiz.\n` +
            `Bu holat nazoratga yuborildi.\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>`;

        // 1) QA guruhiga
        let sentToGroup = false;
        if (QA_GROUP_CHAT_ID) {
            sentToGroup = await sendTelegramMessage(QA_GROUP_CHAT_ID, escalationText);
            if (sentToGroup) escalated++;
        }

        // 2) Operatorga ikkinchi ogohlantirish
        if (operatorUser?.chat_id) {
            await sendTelegramMessage(operatorUser.chat_id, warningText);
        }

        // ✅ Faqat guruhga muvaffaqiyatli yuborilganda update va history yoziladi
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

// ─── NoPurchase: Faqat nazoratchiga escalation ──────────────────────────────

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
        $or: [
            { noPurchaseEscalatedAt: { $exists: false } },
            { noPurchaseEscalatedAt: null },
        ],
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
            `${mentionTag}, <b>${operatorName}</b> — lead <b>"Xarid bo'lmadi"</b> statusiga o'tkazildi va ${NO_PURCHASE_DELAY_MS / 60000} daqiqa ichida ishlanmadi.\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n` +
            `⏱ Bump vaqti: ${
                lead.consideringBumpedAt
                    ? new Date(lead.consideringBumpedAt).toLocaleString('uz-UZ', { timeZone: TZ })
                    : '—'
            }\n\n` +
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
            {
                _id: { $in: idsToUpdate },
                status: NO_PURCHASE_STATUS,
                consideringBumped: true,
                $or: [
                    { noPurchaseEscalatedAt: { $exists: false } },
                    { noPurchaseEscalatedAt: null },
                ],
            },
            { $set: { noPurchaseEscalatedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return escalated;
}

// ─── Main ───────────────────────────────────────────────────────────────────


// ─── Closed: Faqat nazoratchiga escalation ──────────────────────────────────

async function processClosedEscalation(now) {
    if (!QA_GROUP_CHAT_ID) return 0;

    const { slpCodes, opMap } = await getActiveOperatorsCached();
    if (!slpCodes.length) return 0;

    const cutoff = new Date(now.getTime() - CLOSED_DELAY_MS);

    const filter = {
        status: CLOSED_STATUS,
        consideringBumped: true,
        consideringBumpedAt: { $ne: null, $gte: BUMP_MIN_DATE, $lte: cutoff },
        operator: { $in: slpCodes },
        $or: [
            { closedEscalatedAt: { $exists: false } },
            { closedEscalatedAt: null },
        ],
    };

    const leads = await LeadModel.find(filter)
        .sort({ consideringBumpedAt: -1, _id: -1 })
        .limit(CLOSED_BATCH_SIZE)
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
            `🚨 <b>Yopilgan lead — Nazorat!</b>\n\n` +
            `${mentionTag}, <b>${operatorName}</b> — lead <b>"Yopilgan"</b> statusiga o'tkazildi va ${CLOSED_DELAY_MS / 60000} daqiqa ichida ishlanmadi.\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n` +
            `⏱ Bump vaqti: ${
                lead.consideringBumpedAt
                    ? new Date(lead.consideringBumpedAt).toLocaleString('uz-UZ', { timeZone: TZ })
                    : '—'
            }\n\n` +
            `Iltimos, sababini aniqlang!`;

        const sent = await sendTelegramMessage(QA_GROUP_CHAT_ID, text);
        if (sent) {
            escalated++;
            idsToUpdate.push(lead._id);
            chatEvents.push(buildNotifyChatEvent(lead, now, 'closed_escalate'));
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            {
                _id: { $in: idsToUpdate },
                status: CLOSED_STATUS,
                consideringBumped: true,
                $or: [
                    { closedEscalatedAt: { $exists: false } },
                    { closedEscalatedAt: null },
                ],
            },
            { $set: { closedEscalatedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return escalated;
}

function startLeadBumpNotifyCron() {
    cron.schedule(
        CRON_INTERVAL,
        async () => {
            const now = new Date();

            // ✅ Faqat 09:00–21:00 (Tashkent) orasida ishlaydi
            if (!isWithinWorkingHours(now)) {
                return;
            }

            try {
                const notified = await processNotifyStage(now);
                const escalated = await processEscalateStage(now);
                const noPurchase = await processNoPurchaseEscalation(now);
                const closed = await processClosedEscalation(now);

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

module.exports = { startLeadBumpNotifyCron };