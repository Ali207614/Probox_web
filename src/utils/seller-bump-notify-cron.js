'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');
const User = require('../models/user-model');
const bot = require('../bot');

const TZ = 'Asia/Tashkent';
const CRON_INTERVAL = '*/5 * * * *'; // har 5 daqiqada tekshiradi

// ─── Vaqt sozlamalari ───────────────────────────────────────────────────────
const SELLER_NOTIFY_DELAY_MS = 3 * 60 * 60 * 1000;   // 3 soat — sellerga eslatma
const SELLER_ESCALATE_DELAY_MS = 3 * 60 * 60 * 1000;  // yana 3 soat — escalation

const TARGET_STATUS = 'VisitedStore';

// ─── Guruh va mention ───────────────────────────────────────────────────────
const SELLER_GROUP_CHAT_ID = process.env.SELLER_GROUP_CHAT_ID || null;
const LEAD_LINK_BASE = process.env.LEAD_LINK_BASE || 'https://yourdomain.com/leads';

const SELLER_MENTION_USER_ID = process.env.SELLER_MENTION_USER_ID || null;
const SELLER_MENTION_NAME = process.env.SELLER_MENTION_NAME || 'Savdo bo\'limi';

// ─── Batch ──────────────────────────────────────────────────────────────────
const NOTIFY_BATCH_SIZE = Number(process.env.SELLER_BUMP_NOTIFY_BATCH_SIZE || 30);
const ESCALATE_BATCH_SIZE = Number(process.env.SELLER_BUMP_ESCALATE_BATCH_SIZE || 30);
const NO_SELLER_BATCH_SIZE = Number(process.env.SELLER_BUMP_NO_SELLER_BATCH_SIZE || 30);

// ✅ Faqat shu sanadan boshlab yaratilgan leadlar ishlanadi
const BUMP_MIN_DATE = new Date(process.env.SELLER_BUMP_MIN_DATE || '2026-03-01T00:00:00+05:00');

// ─── Ish vaqti ──────────────────────────────────────────────────────────────
const WORK_HOUR_START = Number(process.env.WORK_HOUR_START || 9);
const WORK_HOUR_END = Number(process.env.WORK_HOUR_END || 21);

const STATUS_LABEL = "Do'konga keldi";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isWithinWorkingHours(date) {
    const hour = new Date(date.toLocaleString('en-US', { timeZone: TZ })).getHours();
    return hour >= WORK_HOUR_START && hour < WORK_HOUR_END;
}

function buildLeadLink(leadId) {
    return `${LEAD_LINK_BASE}/${leadId}`;
}

function buildMentionTag() {
    if (SELLER_MENTION_USER_ID) {
        return `<a href="tg://user?id=${SELLER_MENTION_USER_ID}">${SELLER_MENTION_NAME}</a>`;
    }
    return SELLER_MENTION_NAME;
}

async function sendTelegramMessage(chatId, text) {
    if (!chatId) return false;
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        return true;
    } catch (err) {
        console.error(`[CRON:seller-bump] TG send error (chat_id=${chatId}):`, err?.message || err);
        return false;
    }
}

// ─── Seller cache (User modelidan) ─────────────────────────────────────────
const SELLERS_CACHE_TTL_MS = Number(process.env.SELLERS_CACHE_TTL_MS || 5 * 60 * 1000);
let SELLERS_CACHE = { at: 0, sellerMap: new Map() };

/**
 * Seller — slpCode orqali emas, `seller` field orqali bog'lanadi.
 * User modelida seller kodni saqlash formati sizning tizimingizga bog'liq.
 * Bu yerda seller field = slpCode deb olingan (kerak bo'lsa o'zgartiring).
 */
async function getActiveSellersCached(force = false) {
    const now = Date.now();

    if (!force && SELLERS_CACHE.sellerMap.size && now - SELLERS_CACHE.at < SELLERS_CACHE_TTL_MS) {
        return { sellerMap: SELLERS_CACHE.sellerMap, fromCache: true };
    }

    const rows = await User.find({
        slpCode: { $ne: null },
        chat_id: { $ne: null },
    })
        .select('slpCode chat_id fullName slpBranch slpRole')
        .lean();

    const sellerMap = new Map();
    for (const u of rows) sellerMap.set(String(u.slpCode), u);

    SELLERS_CACHE = { at: now, sellerMap };
    return { sellerMap, fromCache: false };
}

// ─── History ────────────────────────────────────────────────────────────────

function buildChatEvent(lead, now, stage) {
    const labels = {
        notify: 'Sellerga eslatma',
        escalate: "Bo'lim boshlig'iga escalation",
        no_seller: 'Sotuvchi biriktirilmagan — guruhga yuborildi',
    };

    const delayLabel =
        stage === 'escalate'
            ? `${(SELLER_NOTIFY_DELAY_MS + SELLER_ESCALATE_DELAY_MS) / 3600000} soat`
            : `${SELLER_NOTIFY_DELAY_MS / 3600000} soat`;

    return {
        leadId: lead._id,
        type: 'event',
        isSystem: true,
        action: 'field_changed',
        createdBy: 0,
        message: `Tizim: ${labels[stage]} — ${delayLabel} ichida ishlanmadi.`,
        changes: [
            {
                field:
                    stage === 'escalate'
                        ? 'sellerBumpEscalatedAt'
                        : stage === 'no_seller'
                            ? 'sellerBumpNoSellerAt'
                            : 'sellerBumpNotifiedAt',
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
        console.error('[CRON:seller-bump] history insert error:', err?.message || err);
    }
}

// ─── Stage 0: Seller biriktirilmagan leadlar → guruhga ─────────────────────

async function processNoSellerStage(now) {
    if (!SELLER_GROUP_CHAT_ID) return 0;

    const cutoff = new Date(now.getTime() - SELLER_NOTIFY_DELAY_MS);

    const filter = {
        status: TARGET_STATUS,
        updatedAt: { $gte: BUMP_MIN_DATE, $lte: cutoff },
        $or: [
            { seller: { $exists: false } },
            { seller: null },
            { seller: '' },
        ],
        $and: [
            {
                $or: [
                    { sellerBumpNoSellerAt: { $exists: false } },
                    { sellerBumpNoSellerAt: null },
                ],
            },
        ],
    };

    const leads = await LeadModel.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .limit(NO_SELLER_BATCH_SIZE)
        .select('_id n status operator clientName clientPhone updatedAt time newTime')
        .lean();

    if (!leads.length) return 0;

    let sent = 0;
    const chatEvents = [];
    const idsToUpdate = [];
    const mentionTag = buildMentionTag();

    for (const lead of leads) {
        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";

        const timeStr = lead.time ? new Date(lead.time).toLocaleString('uz-UZ', { timeZone: TZ }) : '—';
        const newTimeStr = lead.newTime ? new Date(lead.newTime).toLocaleString('uz-UZ', { timeZone: TZ }) : '—';

        const text =
            `⚠️ <b>Sotuvchi biriktirilmagan!</b>\n\n` +
            `${mentionTag}, <b>${STATUS_LABEL}</b> statusidagi leadga ${SELLER_NOTIFY_DELAY_MS / 3600000} soat davomida seller biriktirilmagan.\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `🕒 Time: <b>${timeStr}</b>\n` +
            `🕘 NewTime: <b>${newTimeStr}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n\n` +
            `Iltimos, seller biriktiring!`;

        const ok = await sendTelegramMessage(SELLER_GROUP_CHAT_ID, text);
        if (ok) {
            sent++;
            idsToUpdate.push(lead._id);
            chatEvents.push(buildChatEvent(lead, now, 'no_seller'));
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            {
                _id: { $in: idsToUpdate },
                status: TARGET_STATUS,
                $or: [
                    { sellerBumpNoSellerAt: { $exists: false } },
                    { sellerBumpNoSellerAt: null },
                ],
            },
            { $set: { sellerBumpNoSellerAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return sent;
}

// ─── Stage 1: Sellerga eslatma (3 soat) ────────────────────────────────────

async function processNotifyStage(now) {
    const { sellerMap } = await getActiveSellersCached();
    if (!sellerMap.size) return 0;

    const cutoff = new Date(now.getTime() - SELLER_NOTIFY_DELAY_MS);

    const filter = {
        status: TARGET_STATUS,
        seller: { $ne: null, $nin: [''] },
        $or: [{ sellerBumpNotifiedAt: { $exists: false } }, { sellerBumpNotifiedAt: null }],

        // ✅ statusga o‘tgan vaqt (statusChangedAt) bo‘yicha ishlaydi
        $expr: {
            $and: [
                {
                    $gte: [
                        { $ifNull: ['$statusChangedAt', { $ifNull: ['$newTime', '$time'] }] },
                        BUMP_MIN_DATE,
                    ],
                },
                {
                    $lte: [
                        { $ifNull: ['$statusChangedAt', { $ifNull: ['$newTime', '$time'] }] },
                        cutoff,
                    ],
                },
            ],
        },
    };

    const leads = await LeadModel.find(filter)
        .sort({ _id: -1 })
        .limit(NOTIFY_BATCH_SIZE)
        .select('_id n status seller operator clientName clientPhone time newTime statusChangedAt')
        .lean();

    if (!leads.length) return 0;

    let notified = 0;
    const chatEvents = [];
    const idsToUpdate = [];

    for (const lead of leads) {
        const sellerUser = sellerMap.get(String(lead.seller)) || null;
        if (!sellerUser?.chat_id) continue;

        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";

        const baseAt = lead.statusChangedAt || lead.newTime || lead.time || null;
        const baseAtStr = baseAt ? new Date(baseAt).toLocaleString('uz-UZ', { timeZone: TZ }) : '—';

        const text =
            `⚠️ <b>Eslatma!</b>\n\n` +
            `<b>${STATUS_LABEL}</b> statusiga o‘tganiga ${SELLER_NOTIFY_DELAY_MS / 3600000} soat bo‘ldi.\n` +
            `🕒 Status vaqti: <b>${baseAtStr}</b>\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n\n` +
            `Iltimos, tezroq aloqaga chiqing!`;

        const ok = await sendTelegramMessage(sellerUser.chat_id, text);
        if (ok) {
            notified++;
            idsToUpdate.push(lead._id);
            chatEvents.push(buildChatEvent(lead, now, 'notify'));
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            {
                _id: { $in: idsToUpdate },
                status: TARGET_STATUS,
                seller: { $ne: null, $nin: [''] },
                $or: [{ sellerBumpNotifiedAt: { $exists: false } }, { sellerBumpNotifiedAt: null }],
            },
            { $set: { sellerBumpNotifiedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return notified;
}

// ─── Stage 2: Escalation (3 + 3 = 6 soat) ──────────────────────────────────

async function processEscalateStage(now) {
    const { sellerMap } = await getActiveSellersCached();

    const cutoff = new Date(now.getTime() - SELLER_ESCALATE_DELAY_MS);

    const filter = {
        status: TARGET_STATUS,
        seller: { $ne: null, $nin: [''] },
        sellerBumpNotifiedAt: { $ne: null, $lte: cutoff },
        $or: [{ sellerBumpEscalatedAt: { $exists: false } }, { sellerBumpEscalatedAt: null }],

        // ✅ faqat BUMP_MIN_DATE dan keyin statusga o‘tgan leadlar
        $expr: {
            $gte: [
                { $ifNull: ['$statusChangedAt', { $ifNull: ['$newTime', '$time'] }] },
                BUMP_MIN_DATE,
            ],
        },
    };

    const leads = await LeadModel.find(filter)
        .sort({ sellerBumpNotifiedAt: -1, _id: -1 })
        .limit(ESCALATE_BATCH_SIZE)
        .select('_id n status seller operator clientName clientPhone time newTime statusChangedAt sellerBumpNotifiedAt')
        .lean();

    if (!leads.length) return 0;

    let escalated = 0;
    const chatEvents = [];
    const idsToUpdate = [];
    const mentionTag = buildMentionTag();

    for (const lead of leads) {
        const sellerUser = sellerMap.get(String(lead.seller)) || null;
        const sellerName = sellerUser?.fullName || `Seller: ${lead.seller}`;

        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";
        const totalHours = (SELLER_NOTIFY_DELAY_MS + SELLER_ESCALATE_DELAY_MS) / 3600000;

        const statusAt = lead.statusChangedAt || lead.newTime || lead.time || null;
        const statusAtStr = statusAt ? new Date(statusAt).toLocaleString('uz-UZ', { timeZone: TZ }) : '—';

        const escalationText =
            `🚨 <b>Escalation!</b>\n\n` +
            `${mentionTag}, <b>${sellerName}</b> — <b>${STATUS_LABEL}</b> leadga ${totalHours} soat ichida ishlanmadi.\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n` +
            `🕒 Status vaqti: <b>${statusAtStr}</b>\n\n` +
            `Iltimos, chora ko'ring!`;

        let sentToGroup = false;
        if (SELLER_GROUP_CHAT_ID) {
            sentToGroup = await sendTelegramMessage(SELLER_GROUP_CHAT_ID, escalationText);
            if (sentToGroup) escalated++;
        }

        if (sellerUser?.chat_id) {
            const warningText =
                `🚨 <b>Ogohlantirish!</b>\n\n` +
                `Siz <b>${STATUS_LABEL}</b> leadga ${totalHours} soat ichida aloqaga chiqmadingiz.\n` +
                `Bu holat nazoratga yuborildi.\n\n` +
                `👤 Mijoz: <b>${clientInfo}</b>\n` +
                `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>`;

            await sendTelegramMessage(sellerUser.chat_id, warningText);
        }

        if (sentToGroup) {
            idsToUpdate.push(lead._id);
            chatEvents.push(buildChatEvent(lead, now, 'escalate'));
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            {
                _id: { $in: idsToUpdate },
                status: TARGET_STATUS,
                seller: { $ne: null, $nin: [''] },
                $or: [{ sellerBumpEscalatedAt: { $exists: false } }, { sellerBumpEscalatedAt: null }],
            },
            { $set: { sellerBumpEscalatedAt: now, updatedAt: now } }
        );
    }

    await insertHistory(chatEvents);
    return escalated;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function startSellerBumpNotifyCron() {
    cron.schedule(
        CRON_INTERVAL,
        async () => {
            const now = new Date();

            if (!isWithinWorkingHours(now)) return;

            try {
                const noSeller = await processNoSellerStage(now);
                const notified = await processNotifyStage(now);
                const escalated = await processEscalateStage(now);

                console.log(
                    `[CRON:seller-bump] done | now=${now.toISOString()} no_seller=${noSeller} notified=${notified} escalated=${escalated}`
                );
            } catch (err) {
                console.error('[CRON:seller-bump] error:', err?.message || err);
            }
        },
        { timezone: TZ }
    );
}

module.exports = { startSellerBumpNotifyCron };