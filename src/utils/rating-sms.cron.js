const cron = require('node-cron');
const axios = require('axios');
const LeadModel = require('../models/lead-model');
const LeadChatModel = require('../models/lead-chat-model');

// SMS API sozlamalari
const SMS_API_URL = 'https://send.smsxabar.uz/broker-api/send';
const SMS_USERNAME = process.env.SMS_USERNAME || 'SIZNING_LOGININGIZ';
const SMS_PASSWORD = process.env.SMS_PASSWORD || 'SIZNING_PAROLINGIZ';

const basicAuthToken = Buffer.from(`${SMS_USERNAME}:${SMS_PASSWORD}`).toString('base64');
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const BATCH_SIZE = 20;

async function sendRatingSms(phone, leadId) {
    const cleanPhone = phone.replace(/\D/g, '');

    const payload = {
        messages: {
            recipient: cleanPhone,
            "message-id": `rating_${leadId}_${Date.now()}`,
            sms: {
                originator: "PROBOX",
                content: {
                    text: `Hurmatli mijoz! Sizning fikringiz Probox uchun juda qadrlidir. Sotuvchini baholab, xizmatimizni yanada yaxshilashga yordam bering:\n\t\n https://work.probox.uz/rating/${leadId}`
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

        if (response.status === 200) {
            return { success: true };
        } else {
            return { success: false, error: `Noma'lum xato. Status: ${response.status}` };
        }
    } catch (error) {
        const errMsg = error?.response?.data?.message || error?.response?.data || error.message;
        console.error(`[CRON:rating-sms] SMS jo'natishda xatolik (Lead: ${leadId}):`, errMsg);
        return { success: false, error: JSON.stringify(errMsg) };
    }
}

async function processRatingSms() {
    const now = new Date();

    // =========================================================================
    // 🛠 1. TEST REJIMI UCHUN FILTER (Hozir ishlab turibdi)
    // =========================================================================
    // const testIds = [
    //     '6914163f6ce698946c044743',
    //     '690ae2c2ed859c7e5bb4b14b',
    //     '6914163f6ce698946c0446a9'
    // ];
    //
    // const filter = {
    //     _id: { $in: testIds },
    //     clientPhone: { $exists: true, $ne: null, $ne: '' }
    // };
    // =========================================================================


    // =========================================================================
    // 🚀 2. PROD (JONLI) REJIM UCHUN FILTER (Test tugagach shuni ochasiz)
    // =========================================================================
    const twoHoursAgo = new Date(now.getTime() - TWO_HOURS_MS);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const filter = {
        status: 'Purchased',
        isRatingSmsSent: false,
        statusChangedAt: {
            $lte: twoHoursAgo,
            $gte: startOfToday
        },
        clientPhone: { $exists: true, $ne: null, $ne: '' }
    };
    // =========================================================================


    // Bazadan qidirish
    const leads = await LeadModel.find(filter)
        .sort({ statusChangedAt: 1 }) // Test payti buni ahamiyati yo'q, lekin prod uchun kerak
        .limit(BATCH_SIZE)
        .select('_id clientPhone statusChangedAt')
        .lean();

    if (!leads.length) return 0;

    let sentCount = 0;
    const idsToUpdateSuccess = [];
    const chatEvents = [];

    for (const lead of leads) {
        const result = await sendRatingSms(lead.clientPhone, lead._id);

        if (result.success) {
            sentCount++;
            idsToUpdateSuccess.push(lead._id);

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
        } else {
            await LeadModel.updateOne(
                { _id: lead._id },
                {
                    $set: {
                        isRatingSmsSent: true,
                        ratingSmsError: `SMS Error: ${result.error}`,
                        updatedAt: now
                    }
                }
            );

            chatEvents.push({
                leadId: lead._id,
                type: 'event',
                isSystem: true,
                action: 'field_changed',
                createdBy: 0,
                message: `Tizim xatosi: Reyting SMS jo'natib bo'lmadi.\nSabab: ${result.error}`,
                createdAt: now,
                updatedAt: now,
            });
        }
    }

    if (idsToUpdateSuccess.length > 0) {
        await LeadModel.updateMany(
            { _id: { $in: idsToUpdateSuccess } },
            { $set: { isRatingSmsSent: true, updatedAt: now } }
        );
    }

    if (chatEvents.length > 0) {
        try {
            await LeadChatModel.insertMany(chatEvents, { ordered: false });
        } catch (err) {
            console.error('[CRON:rating-sms] history insert error:', err?.message);
        }
    }

    return sentCount;
}

function startRatingSmsCron() {

    // =========================================================================
    // 🛠 TEST UCHUN CRON: Har 1 minutda ishlaydi (Hozir yoniq)
    // =========================================================================
    //const cronExpression = '* * * * *';
    //const cronExpression = '*/5 * * * *';

    // =========================================================================
    // 🚀 PROD UCHUN CRON: Har soat boshida ishlaydi (Test tugagach shuni ochasiz)
    // =========================================================================
     const cronExpression = '0 * * * *';

    cron.schedule(cronExpression, async () => {
        try {
            console.log(`[CRON:rating-sms] Jarayon boshlandi... (${new Date().toISOString()})`);
            const sent = await processRatingSms();
            if (sent > 0) {
                console.log(`[CRON:rating-sms] ✅ ${sent} ta mijozga reyting SMS jo'natildi.`);
            }
        } catch (error) {
            console.error('[CRON:rating-sms] ❌ CRITICAL ERROR:', error?.stack || error);
        }
    }, {
        timezone: "Asia/Tashkent"
    });
}

module.exports = {
    startRatingSmsCron
};