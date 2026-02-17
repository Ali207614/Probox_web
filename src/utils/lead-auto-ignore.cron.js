'use strict';

const cron = require('node-cron');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

function getSinceDate(lead) {
  return lead.createdAt || lead.time || lead.newTime || lead.updatedAt || null;
}

// ✅ Asia/Tashkent bo'yicha bugun 00:00 ni topamiz (UTC offsetni qo'lda hisoblaymiz)
function startOfTodayTashkent(now = new Date()) {
  // Tashkent doim UTC+5 deb hisoblaymiz (agar DST bo'lmasa)
  const TASHKENT_OFFSET_MIN = 5 * 60;

  // local -> "tashkent local"ga o'tkazamiz
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  const tashkentMs = utcMs + TASHKENT_OFFSET_MIN * 60 * 1000;
  const t = new Date(tashkentMs);

  // tashkent bo'yicha 00:00
  t.setHours(0, 0, 0, 0);

  // qaytadan UTC vaqtga qaytaramiz
  const backUtcMs = t.getTime() - TASHKENT_OFFSET_MIN * 60 * 1000;
  const backLocalMs = backUtcMs - now.getTimezoneOffset() * 60 * 1000;

  return new Date(backLocalMs);
}

function startLeadAutoIgnoreCron() {
  cron.schedule(
    '0 * * * *', // ✅ har soatda 1 marta (xohlasangiz '*/5 * * * *' qiling)
    async () => {
      try {
        console.log('[CRON] lead auto-ignore started ---------------------------------------------------');

        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        // ✅ BUGUN 00:00 (Asia/Tashkent) dan boshlab
        const startToday = startOfTodayTashkent(now);

        // ✅ faqat bugungi leadlar + 1 soatdan oshganlar
        const filter = {
          status: 'Active',
          statusChangedAt: null,
          createdAt: { $gte: startToday, $lte: oneHourAgo },
        };

        const targets = await LeadModel.find(filter)
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
            ].join(' ')
          )
          .lean();

        if (!targets.length) {
          console.log('[CRON] auto-ignore: no targets');
          console.log('[CRON] lead auto-ignore finished --------------------------------------------------');
          return;
        }

        const ids = targets.map((t) => t._id);

        const updateRes = await LeadModel.updateMany(
          { _id: { $in: ids }, status: 'Active', statusChangedAt: null },
          {
            $set: {
              status: 'Ignored',
              statusChangedAt: now,
              'pbx.prev_status': 'Active',
              recallDate: null,
              updatedAt: now,
            },
          }
        );

        const modified = updateRes?.modifiedCount ?? updateRes?.nModified ?? 0;

        const reason = "Bugungi Active lead 1 soat ichida ishlanmagan";

        const chatEvents = targets.map((lead) => {
          const since = getSinceDate(lead);

          return {
            leadId: lead._id,
            type: 'event',
            isSystem: true,
            action: 'status_changed', // agar enum mos bo'lmasa 'field_changed'
            createdBy: 0,
            message: `Tizim: lead Ignored qilindi (${reason}).`,
            changes: [
              { field: 'status', from: lead.status || 'Active', to: 'Ignored' },
              { field: 'statusChangedAt', from: lead.statusChangedAt || null, to: now },
              { field: 'recallDate', from: lead.recallDate || null, to: null },
              { field: 'since', from: since, to: now },
            ],
            statusFrom: lead.status || 'Active',
            statusTo: 'Ignored',
            createdAt: now,
            updatedAt: now,
          };
        });

        try {
          await LeadChatModel.insertMany(chatEvents, { ordered: false });
        } catch (e) {
          console.error('[CRON] auto-ignore: history insert error:', e?.message || e);
        }

        console.log(
          `[CRON] auto-ignore done. targets=${targets.length} modified=${modified} history=${chatEvents.length}`
        );
        console.log('[CRON] lead auto-ignore finished --------------------------------------------------');
      } catch (err) {
        console.error('[CRON] lead auto-ignore error:', err);
      }
    },
    { timezone: 'Asia/Tashkent' }
  );
}

module.exports = { startLeadAutoIgnoreCron };
