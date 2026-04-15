const VerificationCodeModel = require('../models/verification-code-model');
const { sendSms } = require('../services/sms.service');

const sendVerificationCode = async (req, res) => {
    try {
        const { phone , devices} = req.body;
        if (!phone) {
            return res.status(400).json({ status: false, message: "Telefon raqam kiritilmagan" });
        }

        // 1. Raqamni tozalaymiz (faqat raqamlar qoladi) va 998 prefiksini qo'shamiz
        let cleanPhone = String(phone).replace(/\D/g, '');
        if (cleanPhone.length !== 12 || !cleanPhone.startsWith('998')) {
            cleanPhone = '998' + cleanPhone.slice(-9);
        }

        // 2. 4 xonali kod yaratamiz (1000 dan 9999 gacha)
        const code = Math.floor(1000 + Math.random() * 9000).toString();

        // 3. Matnni shakllantiramiz
        const deviceNames = Array.isArray(devices)
            ? devices.map(d => d.name).join(', ')
            : "Tanlangan mahsulotlar";

        const local9 = cleanPhone.slice(-9);
        const isUcell = local9.startsWith('93') || local9.startsWith('94') || local9.startsWith('50') || local9.startsWith('04');

        const text =  `Assalomu alaykum, Mijoz! Bu Probox jamoasi.\n\t\nApple sizniki bo'lishiga bir qadam qoldi. Xaridingizni xavfsiz tasdiqlash uchun menejerga ushbu maxsus kodni taqdim eting:\n\t\nKod: ${code}\n\t\nTexnikangiz uzoq vaqt xizmatingizda bo'lsin! Bizni tanlaganingizdan xursandmiz.`;

        // 4. Eskisi bo'lsa o'chirib, yangisini bazaga saqlaymiz
        await VerificationCodeModel.deleteMany({ phone: cleanPhone });
        await VerificationCodeModel.create({ phone: cleanPhone, code });

        // 5. SMS jo'natamiz
        console.log(cleanPhone, text);
        const smsResult = await sendSms(cleanPhone, text, `verif_${Date.now()}`);

        if (!smsResult.success) {
            return res.status(500).json({
                status: false,
                message: smsResult.error === 'Faqat test raqamlarga ruxsat berilgan'
                    ? "Kechirasiz, hozircha faqat test raqamlariga SMS jo'natish mumkin."
                    : "SMS jo'natishda xatolik: " + smsResult.error
            });
        }

        return res.status(200).json({ status: true, message: "Kod muvaffaqiyatli jo'natildi" });

    } catch (error) {
        console.error("SMS jo'natish xatosi:", error);
        return res.status(500).json({ status: false, message: "Tizim xatosi" });
    }
};

module.exports = {
    sendVerificationCode
};