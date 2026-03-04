'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');
const User = require('../models/user-model');
const bot = require('../bot');

const TZ = 'Asia/Tashkent';
const CRON_INTERVAL = '*/30 * * * *';

// 1 soat
const SCORING_NOTIFY_DELAY_MS = Number(process.env.SCORING_NOTIFY_DELAY_MS || 60 * 60 * 1000);

const TARGET_STATUS = 'Scoring';

// lead link
const LEAD_LINK_BASE = process.env.LEAD_LINK_BASE || 'https://yourdomain.com/leads';

// batch
const BATCH_SIZE = Number(process.env.SCORING_BUMP_BATCH_SIZE || 20);

// faqat shu sanadan keyingi statuslar (xohlasangiz)
const BUMP_MIN_DATE = new Date(process.env.SCORING_BUMP_MIN_DATE || '2026-03-01T00:00:00+05:00');

// ish vaqti (xohlasangiz)
const WORK_HOUR_START = Number(process.env.WORK_HOUR_START || 9);
const WORK_HOUR_END = Number(process.env.WORK_HOUR_END || 21);

// User modelda scoring roleni qanday saqlaysiz — shu joyni moslang
// Masalan: slpRole = 'scoring' yoki role = 'Scoring'
const SCORING_ROLE_VALUE =  'Scoring';

// ===== helpers =====
function isWithinWorkingHours(date) {
    const hour = new Date(date.toLocaleString('en-US', { timeZone: TZ })).getHours();
    return hour >= WORK_HOUR_START && hour < WORK_HOUR_END;
}

function buildLeadLink(leadId) {
    return `${LEAD_LINK_BASE}/${leadId}`;
}

async function sendTelegramMessage(chatId, text) {
    if (!chatId) return false;
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        return true;
    } catch (err) {
        console.error(`[CRON:scoring-bump] TG send error (chat_id=${chatId}):`, err?.message || err);
        return false;
    }
}

// ===== scoring users cache =====
const SCORERS_CACHE_TTL_MS = Number(process.env.SCORERS_CACHE_TTL_MS || 5 * 60 * 1000);
let SCORERS_CACHE = { at: 0, scorers: [] }; // [{ _id, chat_id, fullName, ... }]

async function getScorersCached(force = false) {
    const now = Date.now();
    if (!force && SCORERS_CACHE.scorers.length && now - SCORERS_CACHE.at < SCORERS_CACHE_TTL_MS) {
        return { scorers: SCORERS_CACHE.scorers, fromCache: true };
    }

    // ⚠️ bu yerda field nomlarini o'zingizdagi User schema ga moslang
    const rows = await User.find({
        chat_id: { $ne: null },
        slpRole: SCORING_ROLE_VALUE, // yoki role: 'Scoring'
    })
        .select('chat_id fullName slpRole')
        .lean();

    SCORERS_CACHE = { at: now, scorers: rows || [] };
    return { scorers: SCORERS_CACHE.scorers, fromCache: false };
}

// ===== history =====
function buildChatEvent(lead, now) {
    const hours = SCORING_NOTIFY_DELAY_MS / 3600000;

    return {
        leadId: lead._id,
        type: 'event',
        isSystem: true,
        action: 'field_changed',
        createdBy: 0,
        message: `Tizim: Scoring statusida ${hours} soat turib qoldi — eslatma yuborildi.`,
        changes: [
            {
                field: 'scoringBumpNotifiedAt',
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
        console.error('[CRON:scoring-bump] history insert error:', err?.message || err);
    }
}

// ===== main logic =====
async function processScoringStage(now) {
    const cutoff = new Date(now.getTime() - SCORING_NOTIFY_DELAY_MS);

    const filter = {
        status: TARGET_STATUS,

        // ✅ statusga o'tgan vaqti: statusChangedAt
        statusChangedAt: { $ne: null, $gte: BUMP_MIN_DATE, $lte: cutoff },

        // ✅ bir marta yuborilgan bo'lsa qayta yubormaymiz
        $or: [{ scoringBumpNotifiedAt: { $exists: false } }, { scoringBumpNotifiedAt: null }],
    };

    const leads = await LeadModel.find(filter)
        .sort({ statusChangedAt: 1, _id: 1 })
        .limit(BATCH_SIZE)
        .select('_id n status clientName clientPhone scoring statusChangedAt')
        .lean();

    if (!leads.length) return 0;

    // scorers ro'yxati (faqat scoring biriktirilmagan leadlar uchun kerak bo'ladi)
    const { scorers } = await getScorersCached();

    let sent = 0;
    const idsToUpdate = [];
    const chatEvents = [];

    for (const lead of leads) {
        const link = buildLeadLink(lead._id);
        const clientInfo = lead.clientName || lead.clientPhone || lead.n || "Noma'lum";
        const statusAtStr = lead.statusChangedAt
            ? new Date(lead.statusChangedAt).toLocaleString('uz-UZ', { timeZone: TZ })
            : '—';

        const text =
            `⚠️ <b>Scoring eslatma!</b>\n\n` +
            `<b>Scoring</b> statusida 1 soatdan oshdi.\n` +
            `🕒 Status vaqti: <b>${statusAtStr}</b>\n\n` +
            `👤 Mijoz: <b>${clientInfo}</b>\n` +
            `📋 Lead: <a href="${link}">${lead.n || lead._id}</a>\n`;

        // 1) scoring biriktirilgan bo'lsa — o'ziga yuboramiz
        if (lead.scoring && String(lead.scoring).trim()) {

            const scoringUser = await User.findOne({
                slpCode: String(lead.scoring),
                chat_id: { $ne: null },
            })
                .select('chat_id fullName slpCode')
                .lean();

            if (scoringUser?.chat_id) {
                const ok = await sendTelegramMessage(scoringUser.chat_id, text);
                if (ok) {
                    sent++;
                    idsToUpdate.push(lead._id);
                    chatEvents.push(buildChatEvent(lead, now));
                }
            }

            continue;
        }

        // 2) scoring biriktirilmagan — hamma scoring role dagilarga yuboramiz
        if (scorers.length) {
            let anyOk = false;

            for (const u of scorers) {
                if (!u?.chat_id) continue;
                const ok = await sendTelegramMessage(u.chat_id, text);
                if (ok) anyOk = true;
            }

            // agar hech bo'lmasa bittasiga ketgan bo'lsa, leadni "notified" qilamiz
            if (anyOk) {
                sent++;
                idsToUpdate.push(lead._id);
                chatEvents.push(buildChatEvent(lead, now));
            }
        }
    }

    if (idsToUpdate.length) {
        await LeadModel.updateMany(
            {
                _id: { $in: idsToUpdate },
                status: TARGET_STATUS,
                $or: [{ scoringBumpNotifiedAt: { $exists: false } }, { scoringBumpNotifiedAt: null }],
            },
            { $set: { scoringBumpNotifiedAt: now, updatedAt: now } },
        );
    }

    await insertHistory(chatEvents);
    return sent;
}

// ===== cron =====
function startScoringBumpNotifyCron() {
    cron.schedule(
        CRON_INTERVAL,
        async () => {
            const now = new Date();
            if (!isWithinWorkingHours(now)) return;

            try {
                const sent = await processScoringStage(now);
                console.log(`[CRON:scoring-bump] done | now=${now.toISOString()} sent=${sent}`);
            } catch (err) {
                console.error('[CRON:scoring-bump] error:', err?.message || err);
            }
        },
        { timezone: TZ },
    );
}

module.exports = { startScoringBumpNotifyCron };