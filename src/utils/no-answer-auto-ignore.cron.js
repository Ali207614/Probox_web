'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

const TZ = 'Asia/Tashkent';

// 1-marta: 3 soat, keyin: 12 soat
const FIRST_NOANSWER_DELAY_MS = Number(process.env.FIRST_NOANSWER_DELAY_MS || 3 * 60 * 60 * 1000);
const NEXT_NOANSWER_DELAY_MS = Number(process.env.NEXT_NOANSWER_DELAY_MS || 12 * 60 * 60 * 1000);

// Cron interval
const CRON_INTERVAL = process.env.NOANSWER_CRON_INTERVAL || '0 * * * *'; // har soatda 1 marta

// Batch
const BATCH_SIZE = Number(process.env.NOANSWER_AUTO_IGNORE_BATCH_SIZE || 500);

// Optional: faqat shu sanadan keyingi leadlar
const BUMP_MIN_DATE = new Date(process.env.NOANSWER_BUMP_MIN_DATE || '2025-02-01T00:00:00+05:00');

// Optional: source exclude
const EXCLUDE_SOURCE = process.env.NOANSWER_EXCLUDE_SOURCE || 'Organika';

function getNoAnswerBaseAt(lead) {
    // talab: statusChangedAt bo‘lsa shundan, bo‘lmasa createdAt
    return lead.statusChangedAt || lead.createdAt || null;
}

function buildChatEvent({ lead, now, baseAt, count, delayHours }) {
    const reason = `NoAnswer (${count}-marta): ${delayHours} soat ichida ishlanmagan`;

    return {
        leadId: lead._id,
        type: 'event',
        isSystem: true,
        action: 'status_changed',
        createdBy: 0,
        message: `Tizim: lead Ignored qilindi (${reason}).`,
        changes: [
            { field: 'status', from: 'NoAnswer', to: 'Ignored' },
            { field: 'statusChangedAt', from: lead.statusChangedAt || null, to: now },
            { field: 'recallDate', from: lead.recallDate || null, to: null },
            { field: 'noAnswerBaseAt', from: baseAt, to: now },
            { field: 'noAnswerCountCron', from: count, to: count },
        ],
        statusFrom: 'NoAnswer',
        statusTo: 'Ignored',
        createdAt: now,
        updatedAt: now,
    };
}

async function insertHistory(chatEvents) {
    if (!chatEvents.length) return;
    try {
        await LeadChatModel.insertMany(chatEvents, { ordered: false });
    } catch (e) {
        console.error('[CRON] noanswer->ignored: history insert error:', e?.message || e);
    }
}

async function processNoAnswerAutoIgnore(now) {
    const minCutoff = new Date(now.getTime() - FIRST_NOANSWER_DELAY_MS);

    const filter = {
        status: 'NoAnswer',
        createdAt: { $gte: BUMP_MIN_DATE },
        $or: [
            { statusChangedAt: { $ne: null, $lte: minCutoff } },
            { statusChangedAt: null, createdAt: { $lte: minCutoff } },
        ],
    };

    const candidates = await LeadModel.find(filter)
        .sort({ statusChangedAt: 1, _id: 1 })
        .limit(BATCH_SIZE)
        .select(
            [
                '_id',
                'n',
                'status',
                'statusChangedAt',
                'createdAt',
                'updatedAt',
                'time',
                'newTime',
                'recallDate',
                'pbx.prev_status',
                'noAnswerCountCron',
            ].join(' '),
        )
        .lean();

    if (!candidates.length) return { candidates: 0, targets: 0, modified: 0, history: 0 };

    const firstCutoff = new Date(now.getTime() - FIRST_NOANSWER_DELAY_MS);
    const nextCutoff = new Date(now.getTime() - NEXT_NOANSWER_DELAY_MS);

    const targetsFirst = [];
    const targetsNext = [];

    for (const lead of candidates) {
        const baseAt = getNoAnswerBaseAt(lead);
        if (!baseAt) continue;

        // ✅ yangi counter: yo‘q bo‘lsa 1 deb olamiz (cron birinchi marta ko‘ryapti degani)
        const count = Number.isFinite(lead.noAnswerCountCron) ? Number(lead.noAnswerCountCron) : 1;

        if (count <= 1) {
            if (baseAt <= firstCutoff) targetsFirst.push({ lead, baseAt, count });
        } else {
            if (baseAt <= nextCutoff) targetsNext.push({ lead, baseAt, count });
        }
    }

    const idsFirst = targetsFirst.map((x) => x.lead._id);
    const idsNext = targetsNext.map((x) => x.lead._id);

    let modified = 0;

    if (idsFirst.length) {
        const res1 = await LeadModel.updateMany(
            { _id: { $in: idsFirst }, status: 'NoAnswer' },
            {
                $set: {
                    status: 'Ignored',
                    statusChangedAt: now,
                    'pbx.prev_status': 'NoAnswer',
                    recallDate: null,
                    updatedAt: now,
                },
            },
        );
        modified += res1?.modifiedCount ?? res1?.nModified ?? 0;
    }

    if (idsNext.length) {
        const res2 = await LeadModel.updateMany(
            { _id: { $in: idsNext }, status: 'NoAnswer' },
            {
                $set: {
                    status: 'Ignored',
                    statusChangedAt: now,
                    'pbx.prev_status': 'NoAnswer',
                    recallDate: null,
                    updatedAt: now,
                },
            },
        );
        modified += res2?.modifiedCount ?? res2?.nModified ?? 0;
    }

    const chatEvents = [];

    for (const x of targetsFirst) {
        chatEvents.push(
            buildChatEvent({
                lead: x.lead,
                now,
                baseAt: x.baseAt,
                count: x.count,
                delayHours: FIRST_NOANSWER_DELAY_MS / 3600000,
            }),
        );
    }

    for (const x of targetsNext) {
        chatEvents.push(
            buildChatEvent({
                lead: x.lead,
                now,
                baseAt: x.baseAt,
                count: x.count,
                delayHours: NEXT_NOANSWER_DELAY_MS / 3600000,
            }),
        );
    }

    await insertHistory(chatEvents);

    return {
        candidates: candidates.length,
        targets: idsFirst.length + idsNext.length,
        modified,
        history: chatEvents.length,
    };
}

function startNoAnswerAutoIgnoreCron() {
    cron.schedule(
        CRON_INTERVAL,
        async () => {
            try {
                console.log('[CRON] noanswer->ignored started ----------------------------------------------');
                const now = new Date();

                const res = await processNoAnswerAutoIgnore(now);

                console.log(
                    `[CRON] noanswer->ignored done. candidates=${res.candidates} targets=${res.targets} modified=${res.modified} history=${res.history}`,
                );
                console.log('[CRON] noanswer->ignored finished --------------------------------------------');
            } catch (err) {
                console.error('[CRON] noanswer->ignored error:', err?.message || err);
            }
        },
        { timezone: TZ },
    );
}

module.exports = { startNoAnswerAutoIgnoreCron };