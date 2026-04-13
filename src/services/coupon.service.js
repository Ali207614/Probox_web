require('dotenv').config();
const axios = require('axios');


async function sendCouponStatusWebhook({
                                           leadId,
                                           phoneNumber,
                                           status,
                                           fullName,
                                           productName,
                                           referral
                                       }) {
    try {
        if (!phoneNumber) {
            console.warn('[coupon-webhook] skipped: phone_number is empty');
            return;
        }

        const payload = {
            phone_number: phoneNumber,
            full_name: fullName || null,
            status,
            lead_id: String(leadId),
        };

        payload.product_name = productName || 'Unknown';

        if (referral) {
            payload.referral = referral;
        }

        const response = await axios.post(
            process.env.COUPON_API_URL,
            payload,
            {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.COUPON_API_KEY}`,
                },
            }
        );

        console.log(`[coupon-webhook] sent successfully for lead ${leadId}`);

        return response.data;
    } catch (error) {
        console.error(
            '[coupon-webhook] failed:',
            error?.response?.data || error.message
        );
        throw error;
    }
}

module.exports = {
    sendCouponStatusWebhook,
};