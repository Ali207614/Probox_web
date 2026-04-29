'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');

const bot = require('../bot');
const OtpCodeModel = require('../models/otp-code-model');
const TelegramUserModel = require('../models/user-model');
const ApiError = require('../exceptions/api-error');

const OTP_LENGTH = 6;
const OTP_TTL_MS = (Number(process.env.OTP_TTL_SECONDS || 300)) * 1000;
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_RESEND_COOLDOWN_MS = Number(process.env.OTP_RESEND_COOLDOWN_MS || 60 * 1000);

const PURPOSE_LABELS = {
    register: "Akkaunt registratsiyasi",
    reset_password: "Parolni tiklash",
    change_credentials: "Login va parolni o'zgartirish",
};

function generateOtpCode() {
    const max = 10 ** OTP_LENGTH;
    const num = crypto.randomInt(0, max);
    return String(num).padStart(OTP_LENGTH, '0');
}

function maskPhone(phone) {
    const s = String(phone || '');
    if (s.length < 4) return '****';
    return `${s.slice(0, 5)}***${s.slice(-2)}`;
}

async function findChatIdByPhone(phone) {
    if (!phone) return null;
    const last9 = String(phone).replace(/\D/g, '').slice(-9);
    if (!last9) return null;

    const tgUser = await TelegramUserModel.findOne({
        phone: { $regex: `${last9}$` },
        chat_id: { $ne: null },
    })
        .select('chat_id phone')
        .lean();

    return tgUser?.chat_id || null;
}

/**
 * @param {Object} args
 * @param {Number} args.slpCode      - SAP SlpCode
 * @param {String} args.phone        - Mobil yoki Telephone (998XXXXXXXXX)
 * @param {String} args.purpose      - reset_password | change_login | change_password | change_credentials
 */
async function sendOtp({ slpCode, phone, purpose }) {
    if (!PURPOSE_LABELS[purpose]) {
        throw ApiError.BadRequest("Noto'g'ri OTP maqsadi");
    }
    if (!slpCode && slpCode !== 0) {
        throw ApiError.BadRequest('slpCode majburiy');
    }
    if (!phone) {
        throw ApiError.BadRequest('Telefon raqam SAP profilida topilmadi');
    }

    const chatId = await findChatIdByPhone(phone);
    if (!chatId) {
        throw ApiError.BadRequest(
            "Telegram chat_id topilmadi. Iltimos, avval botga /start bosib, raqamingizni yuboring."
        );
    }

    const last = await OtpCodeModel.findOne({ slpCode, purpose, usedAt: null })
        .sort({ createdAt: -1 })
        .lean();

    if (last && Date.now() - new Date(last.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil(
            (OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(last.createdAt).getTime())) / 1000
        );
        throw ApiError.BadRequest(`Yangi kod so'rashdan oldin ${waitSec} soniya kuting`);
    }

    await OtpCodeModel.updateMany(
        { slpCode, purpose, usedAt: null },
        { $set: { usedAt: new Date() } }
    );

    const code = generateOtpCode();
    const codeHash = await bcrypt.hash(code, 10);
    const now = new Date();

    await OtpCodeModel.create({
        slpCode,
        purpose,
        codeHash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    });

    const ttlMin = Math.round(OTP_TTL_MS / 60000);
    const text =
        `🔐 <b>${PURPOSE_LABELS[purpose]}</b>\n\n` +
        `Tasdiqlash kodi: <code>${code}</code>\n` +
        `Amal qilish muddati: <b>${ttlMin} daqiqa</b>\n\n` +
        `Agar siz so'ramagan bo'lsangiz, bu xabarni e'tiborsiz qoldiring.`;

    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
        console.error(`[OTP] Telegramga jo'natishda xatolik (chat_id=${chatId}):`, err?.message || err);
        throw ApiError.BadRequest(
            "Telegramga kod jo'natib bo'lmadi. Botda blok qo'ymaganingizni tekshiring."
        );
    }

    return {
        delivered: true,
        chatHint: maskPhone(phone),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    };
}

/**
 * 1-bosqich: kodni tekshirib, OTPni "verified" deb belgilaydi (lekin used emas).
 * Keyin consumeOtp() chaqirilishi kerak.
 */
async function verifyOtp({ slpCode, purpose, code }) {
    if (!code || !/^\d+$/.test(String(code))) {
        throw ApiError.BadRequest("Kod noto'g'ri formatda");
    }

    const otp = await OtpCodeModel.findOne({
        slpCode,
        purpose,
        usedAt: null,
        verifiedAt: null,
    }).sort({ createdAt: -1 });

    if (!otp) {
        throw ApiError.BadRequest("Aktiv kod topilmadi yoki muddati o'tgan");
    }

    if (otp.expiresAt && otp.expiresAt.getTime() < Date.now()) {
        throw ApiError.BadRequest("Kod muddati o'tgan");
    }

    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
        otp.usedAt = new Date();
        await otp.save();
        throw ApiError.BadRequest("Urinishlar tugadi. Yangi kod so'rang.");
    }

    const ok = await bcrypt.compare(String(code), otp.codeHash);
    if (!ok) {
        otp.attempts += 1;
        await otp.save();
        const left = Math.max(0, OTP_MAX_ATTEMPTS - otp.attempts);
        throw ApiError.BadRequest(`Kod noto'g'ri. Qolgan urinishlar: ${left}`);
    }

    otp.verifiedAt = new Date();
    await otp.save();
    return {
        otpId: String(otp._id),
        verifiedAt: otp.verifiedAt,
        expiresAt: otp.expiresAt,
    };
}

/**
 * 2-bosqich: oldin verifyOtp() qilingan OTPni "used" deb belgilaydi.
 * regToken'dan otpId, slpCode, purpose keladi.
 */
async function consumeOtp({ otpId, slpCode, purpose }) {
    if (!otpId) throw ApiError.BadRequest('otpId majburiy');

    const otp = await OtpCodeModel.findOne({
        _id: otpId,
        slpCode,
        purpose,
    });

    if (!otp) {
        throw ApiError.BadRequest('OTP topilmadi');
    }
    if (!otp.verifiedAt) {
        throw ApiError.BadRequest('OTP tasdiqlanmagan');
    }
    if (otp.usedAt) {
        throw ApiError.BadRequest('OTP allaqachon ishlatilgan');
    }
    if (otp.expiresAt && otp.expiresAt.getTime() < Date.now()) {
        throw ApiError.BadRequest("OTP muddati o'tgan. Yangi kod so'rang.");
    }

    otp.usedAt = new Date();
    await otp.save();
    return true;
}

module.exports = {
    sendOtp,
    verifyOtp,
    consumeOtp,
    findChatIdByPhone,
};
