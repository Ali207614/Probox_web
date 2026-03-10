'use strict';

const axios = require('axios');

const SMS_API_URL = 'https://send.smsxabar.uz/broker-api/send';
const SMS_USERNAME = process.env.SMS_USERNAME || 'SIZNING_LOGININGIZ';
const SMS_PASSWORD = process.env.SMS_PASSWORD || 'SIZNING_PAROLINGIZ';
const basicAuthToken = Buffer.from(`${SMS_USERNAME}:${SMS_PASSWORD}`).toString('base64');


async function sendSms(phone, text, messageIdPrefix = 'sms') {
    if (!phone) return { success: false, error: 'Raqam yo\'q' };

    // =================================================================
    // 🛠 TEST REJIMI (Prodga chiqarayotganda shu blokni o'chirib tashlaysiz)
    // =================================================================
    const allowedPhones = ['903367448', '0005770']; // Faqat shu 2 ta raqamga ruxsat

    const isAllowed = allowedPhones.some(num => String(phone).includes(num));
    if (!isAllowed) {
        // Agar boshqa (haqiqiy mijoz) raqami kelsa, SMS jo'natilmaydi
        return { success: false, error: 'Faqat test raqamlarga ruxsat berilgan' };
    }
    // =================================================================

    const cleanPhone = String(phone).replace(/\D/g, '');
    const messageId = `${messageIdPrefix}_${Date.now()}`;

    const payload = {
        messages: {
            recipient: cleanPhone,
            "message-id": messageId,
            sms: {
                originator: "PROBOX",
                content: { text: text }
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
        return { success: response.status === 200, data: response.data };
    } catch (error) {
        const errMsg = error?.response?.data?.message || error?.response?.data || error.message;
        console.error(`[SMS Service] xatolik (${messageId}):`, errMsg);
        return { success: false, error: errMsg };
    }
}


async function sendMissedCallSms(phone, clientName, leadId) {
    const displayName = clientName && clientName !== 'Noma\'lum' ? clientName : 'hurmatli mijoz';

    const text = `Assalomu alaykum, ${displayName}! Bu Probox jamoasi. Siz bilan gaplashishga ulgurmadik, lekin raqamingizni saqlab oldik. Xavotir olmang, sizni unitib qo'ymaymiz. Menejerlarimiz qo'li bo'shashi bilan, taxminan 5-10 daqiqada sizga qo'ng'iroq qilamiz. Sabringiz uchun minnatdormiz.`;

    const result = await sendSms(phone, text, `missed_${leadId}`);
    return result.success; // faqat true/false qaytaradi (webhook uchun yetarli)
}





module.exports = {
    sendSms,
    sendMissedCallSms,
};