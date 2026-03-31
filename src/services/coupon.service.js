const axios = require('axios');

async function sendCouponStatusWebhook({ leadId, phoneNumber }) {
    try {
        if (!phoneNumber) {
            console.warn('[coupon-webhook] skipped: phone_number is empty');
            return;
        }

        await axios.post(
            process.env.COUPON_API_URL,
            {
                phone_number: phoneNumber,
                status: 'VisitedStore',
                lead_id: String(leadId),
            },
            {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.COUPON_API_KEY}`,
                },
            }
        );

        console.log(`[coupon-webhook] sent successfully for lead ${leadId}`);
    } catch (error) {
        console.error(
            '[coupon-webhook] failed:',
            error?.response?.data || error.message
        );
    }
}

module.exports = {
    sendCouponStatusWebhook,
};