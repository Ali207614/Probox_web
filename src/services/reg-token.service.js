'use strict';

const jwt = require('jsonwebtoken');
const ApiError = require('../exceptions/api-error');

const TYPE = 'reg_token';
const TTL = process.env.REG_TOKEN_TTL || '10m';

function getSecret() {
    const s = process.env.secret_key;
    if (!s) throw new Error('secret_key env yo\'q');
    return s;
}

/**
 * Verify bosqichidan keyin yaratiladi.
 * Faqat OtpCode ichida verifiedAt belgilangandan keyin chaqirilishi kerak.
 *
 * @param {Object} args
 * @param {String} args.otpId    - OtpCode._id
 * @param {Number} args.slpCode  - SAP SlpCode
 * @param {String} args.purpose  - register | reset_password | change_credentials
 */
function signRegToken({ otpId, slpCode, purpose }) {
    return jwt.sign(
        { type: TYPE, otpId: String(otpId), slpCode: Number(slpCode), purpose },
        getSecret(),
        { expiresIn: TTL }
    );
}

/**
 * regTokenni tekshirib, payloadni qaytaradi. Yaroqsiz bo'lsa BadRequest tashlaydi.
 */
function verifyRegToken(token, expectedPurpose = null) {
    if (!token || typeof token !== 'string') {
        throw ApiError.BadRequest('regToken majburiy');
    }
    let payload;
    try {
        payload = jwt.verify(token, getSecret());
    } catch (e) {
        throw ApiError.BadRequest("regToken yaroqsiz yoki muddati o'tgan");
    }
    if (payload?.type !== TYPE) {
        throw ApiError.BadRequest('regToken yaroqsiz');
    }
    if (expectedPurpose && payload.purpose !== expectedPurpose) {
        throw ApiError.BadRequest("regToken bu amal uchun emas");
    }
    return payload;
}

module.exports = { signRegToken, verifyRegToken };
