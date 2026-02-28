'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');
const User = require('../models/user-model'); // slpCode -> chat_id
const bot = require('../bot');

const TZ = 'Asia/Tashkent';
const CRON_INTERVAL = '*/2 * * * *'; // har 1 daqiqada tekshiradi

const NOTIFY_DELAY_MS = 10 * 60 * 1000; // 10 daqiqa — operatorga eslatma
const ESCALATE_DELAY_MS = 10 * 60 * 1000; // yana 10 daqiqa — escalation

const TARGET_STATUSES = ['FollowUp', 'Considering', 'WillVisitStore', 'WillSendPassport'];

const QA_GROUP_CHAT_ID = process.env.QA_GROUP_CHAT_ID || null;
const LEAD_LINK_BASE = process.env.LEAD_LINK_BASE || 'https://yourdomain.com/leads';

// ─── Escalation mention (guruhda tag qilinadigan odam) ──────────────────────
const QA_MENTION_USER_ID = process.env.QA_MENTION_USER_ID || null;
const QA_MENTION_NAME = process.env.QA_MENTION_NAME || 'Aloqa markazi';

// Batch size (xohlasangiz env bilan boshqaring)
const NOTIFY_BATCH_SIZE = Number(process.env.BUMP_NOTIFY_BATCH_SIZE || 30);
const ESCALATE_BATCH_SIZE = Number(process.env.BUMP_ESCALATE_BATCH_SIZE || 100);

// ✅ Faqat shu sanadan boshlab yaratilgan leadlar ishlanadi
const BUMP_MIN_DATE = new Date(process.env.BUMP_MIN_DATE || '2025-02-01T00:00:00+05:00');

// Status label
const STATUS_LABELS = {
    FollowUp: 'Qayta aloqa',
    Considering: "O'ylab ko'radi",
    WillVisitStore: "Do'konga boradi",
    WillSendPassport: 'Passport yuboradi',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

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
 * - slpCode hozircha hamma joyda bo'lmasligi mumkin, shuning uchun
 *   leadlarni ham faqat shu slpCode'lar bo'yicha olamiz (aylanib qolmaydi)
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
    const stageLabel = stage === 'escalate' ? "Bo'lim boshlig'iga escalation" : 'Operatorga eslatma';

    return {
        leadId: lead._id,
        type: 'event',
        isSystem: true,
        action: 'field_changed',
        createdBy: 0,
        message: `Tizim: ${stageLabel} jo'natildi — operator ${NOTIFY_DELAY_MS / 60000} daqiqa ichida aloqaga chiqmadi.`,
        changes: [
            {
                field: stage === 'escalate' ? 'bumpEscalatedAt' : 'bumpNotifiedAt',
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
    if (!slpCodes.length) return 0; // ✅ hech kim ulanmagan -> aylanmaydi

    const cutoff = new Date(now.getTime() - NOTIFY_DELAY_MS);

    const filter = {
        status: { $in: TARGET_STATUSES },
        consideringBumped: true,
        consideringBumpedAt: { $ne: null, $gte: BUMP_MIN_DATE, $lte: cutoff },
        operator: { $in: slpCodes }, // ✅ faqat bor slpCode'lar
        $or: [{ bumpNotifiedAt: { $exists: false } }, { bumpNotifiedAt: null }],
    };

    const leads = await LeadModel.find(filter)
        .sort({ consideringBumpedAt: -1, _id: -1 }) // ✅ eng yangilar birinchi
        .limit(NOTIFY_BATCH_SIZE)
        .select('_id n status operator clientName clientPhone consideringBumpedAt recallDate')
        .lean();

    if (!leads.length) return 0;

    let notified = 0;
    const chatEvents = [];
    const idsToUpdate = [];

    for (const lead of leads) {
        const operatorUser = opMap.get(Number(lead.operator)) || null;

        // operator map'da bo'lmasa (race condition bo'lishi mumkin) -> skip, update yo'q
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
        if (sent) notified++;

        idsToUpdate.push(lead._id);
        chatEvents.push(buildNotifyChatEvent(lead, now, 'notify'));
    }

    // ✅ faqat jo'natilgan/ishlangan leadlar update bo'ladi
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
        consideringBumpedAt: { $gte: BUMP_MIN_DATE }, // ✅ faqat fevraldan boshlab
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

    // ✅ Mention tag — guruhda "Aloqa markazi" ni belgilab jo'natish uchun
    const mentionTag = buildMentionTag();

    for (const lead of leads) {
        const operatorUser = opMap.get(Number(lead.operator)) || null;
        const operatorName = operatorUser?.fullName || `SlpCode: ${lead.operator}`;

        const statusLabel = STATUS_LABELS[lead.status] || lead.status;
        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";

        // ✅ mentionTag qo'shildi — guruhda "Aloqa markazi" ni tag qiladi
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

        // 1) QA guruhiga
        if (QA_GROUP_CHAT_ID) {
            const sent = await sendTelegramMessage(QA_GROUP_CHAT_ID, escalationText);
            if (sent) escalated++;
        }

        // 2) Operatorga ikkinchi ogohlantirish (agar chat_id bo'lsa)
        if (operatorUser?.chat_id) {
            const warningText =
                `🚨 <b>Ogohlantirish!</b>\n\n` +
                `Siz <b>${statusLabel}</b> leadga ${(NOTIFY_DELAY_MS + ESCALATE_DELAY_MS) / 60000} daqiqa ichida aloqaga chiqmadingiz.\n` +
                `Bu holat nazoratga yuborildi.\n\n` +
                `👤 Mijoz: <b>${clientInfo}</b>\n` +
                `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>`;

            await sendTelegramMessage(operatorUser.chat_id, warningText);
        }

        idsToUpdate.push(lead._id);
        chatEvents.push(buildNotifyChatEvent(lead, now, 'escalate'));
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

// ─── Main ───────────────────────────────────────────────────────────────────

function startLeadBumpNotifyCron() {
    cron.schedule(
        CRON_INTERVAL,
        async () => {
            const now = new Date();

            try {
                const notified = await processNotifyStage(now);

                // ✅ escalate yoqmoqchi bo'lsangiz uncomment qiling:
                const escalated = await processEscalateStage(now);
                // const escalated = 0;
                //
                console.log(
                    `[CRON:bump-notify] done | now=${now.toISOString()} notified=${notified} escalated=${escalated}`
                );
            } catch (err) {
                console.error('[CRON:bump-notify] error:', err?.message || err);
            }
        },
        { timezone: TZ }
    );
}

module.exports = { startLeadBumpNotifyCron };