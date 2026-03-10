const cron = require('node-cron');
const axios = require('axios'); // Agar axios bo'lmasa, node-fetch ishlatsangiz ham bo'ladi
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

// SMS API sozlamalari
const SMS_API_URL = 'https://send.smsxabar.uz/broker-api/send';
const SMS_USERNAME = process.env.SMS_USERNAME || 'SIZNING_LOGININGIZ';
const SMS_PASSWORD = process.env.SMS_PASSWORD || 'SIZNING_PAROLINGIZ';

// Auth tokenni tayyorlash (Basic Auth)
const basicAuthToken = Buffer.from(`${SMS_USERNAME}:${SMS_PASSWORD}`).toString('base64');

// Vaqt oraliqlari
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const BATCH_SIZE = 50; // Bir urinishda 50 ta SMS


async function sendRatingSms(phone, leadId) {
    // Telefon raqamni tozalash (faqat raqamlarni qoldirish, masalan +998 ni 998 ga aylantirish xizmat talabiga qarab)
    const cleanPhone = phone.replace(/\D/g, '');

    const payload = {
        messages: {
            recipient: cleanPhone,
            "message-id": `rating_${leadId}_${Date.now()}`,
            sms: {
                originator: "PROBOX",
                content: {
                    text: `Hurmatli mijoz! Sizning fikringiz Probox uchun juda qadrlidir. Sotuvchini baholab, xizmatimizni yanada yaxshilashga yordam bering:\n\nhttps://work.probox.uz/rating/${leadId}`
                }
            }
        }
    };

    try {
        const response = await axios.post(SMS_API_URL, payload, {
            headers: {
                'Authorization': `Basic ${basicAuthToken}`,
                'Content-Type': 'application/json'
            }
        });
        return response.status === 200;
    } catch (error) {
        console.error(`[CRON:rating-sms] SMS jo'natishda xatolik (Lead: ${leadId}):`, error?.response?.data || error.message);
        return false;
    }
}

/**
 * Bazadan mijozlarni qidirish va SMS jo'natish mantiqi
 */
async function processRatingSms() {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - TWO_HOURS_MS);

    // Faqat bugun ishlashi uchun: bugungi kunning boshlanishi
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const filter = {
        status: 'Purchased', // Faqat xarid qilinganlar
        isRatingSmsSent: false, // Hali SMS ketmagan bo'lsa
        statusChangedAt: {
            $lte: twoHoursAgo, // 2 soatdan oshgan bo'lishi kerak
            $gte: startOfToday // Faqat bugungi kun uchun
        },
        clientPhone: { $exists: true, $ne: null, $ne: '' } // Raqami borlar
    };

    const leads = await LeadModel.find(filter)
        .sort({ statusChangedAt: 1 })
        .limit(BATCH_SIZE)
        .select('_id clientPhone statusChangedAt')
        .lean();

    if (!leads.length) return 0;

    let sentCount = 0;
    const idsToUpdate = [];
    const chatEvents = [];

    for (const lead of leads) {
        const isSent = await sendRatingSms(lead.clientPhone, lead._id);

        if (isSent) {
            sentCount++;
            idsToUpdate.push(lead._id);

            // Tarixga yozib qo'yish (LeadChat)
            chatEvents.push({
                leadId: lead._id,
                type: 'event',
                isSystem: true,
                action: 'sms_sent',
                createdBy: 0,
                message: `Tizim: Reyting so'rovi SMS orqali mijozga jo'natildi.`,
                createdAt: now,
                updatedAt: now,
            });
        }
    }

    // Jo'natilganlarni bazada yangilash
    if (idsToUpdate.length > 0) {
        await LeadModel.updateMany(
            { _id: { $in: idsToUpdate } },
            { $set: { isRatingSmsSent: true, updatedAt: now } }
        );

        // Tarixlarni saqlash
        try {
            await LeadChatModel.insertMany(chatEvents, { ordered: false });
        } catch (err) {
            console.error('[CRON:rating-sms] history insert error:', err?.message);
        }
    }

    return sentCount;
}

/**
 * Cronjob'ni ishga tushirish (har 10 daqiqada tekshiradi)
 */
function startRatingSmsCron() {
    cron.schedule('0 * * * *', async () => {
        try {
            const sent = await processRatingSms();
            if (sent > 0) {
                console.log(`[CRON:rating-sms] ${sent} ta mijozga reyting SMS jo'natildi. (${new Date().toISOString()})`);
            }
        } catch (error) {
            console.error('[CRON:rating-sms] error:', error?.message || error);
        }
    }, {
        timezone: "Asia/Tashkent"
    });
}

module.exports = {
    startRatingSmsCron
};