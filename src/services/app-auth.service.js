'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const BCRYPT_COST = Number(process.env.APP_AUTH_BCRYPT_COST || 12);
const APP_JWT_EXPIRES = process.env.APP_JWT_EXPIRES || '24h';

function getSecret() {
    const secret = process.env.secret_key;
    if (!secret) {
        throw new Error('JWT secret_key environment variable is not configured');
    }
    return secret;
}

async function hashPassword(plain) {
    if (typeof plain !== 'string' || plain.length < 6) {
        throw new Error("Parol kamida 6 ta belgidan iborat bo'lishi kerak");
    }
    return bcrypt.hash(plain, BCRYPT_COST);
}

async function comparePassword(plain, hash) {
    if (!plain || !hash) return false;
    return bcrypt.compare(plain, hash);
}

function signAppToken(user, role) {
    const payload = {
        type: 'app',
        id: String(user._id),
        login: user.login,
        fullName: user.fullName,
        roleCode: role?.code || null,
        roleName: role?.name || null,
        slpCode: user.slpCode ?? null,
    };
    return jwt.sign(payload, getSecret(), { expiresIn: APP_JWT_EXPIRES });
}

function verifyAppToken(token) {
    try {
        const data = jwt.verify(token, getSecret());
        if (data?.type !== 'app') return null;
        return data;
    } catch {
        return null;
    }
}

module.exports = {
    hashPassword,
    comparePassword,
    signAppToken,
    verifyAppToken,
};
