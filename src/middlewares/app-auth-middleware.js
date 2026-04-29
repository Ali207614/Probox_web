'use strict';

const ApiError = require('../exceptions/api-error');
const AppUserModel = require('../models/app-user-model');
const { verifyAppToken } = require('../services/app-auth.service');

function extractToken(req) {
    const raw = req.headers?.authorization;
    if (!raw) return null;
    return raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
}

const appAuthMiddleware = async (req, res, next) => {
    try {
        const token = extractToken(req);
        if (!token) return next(ApiError.UnauthorizedError());

        const decoded = verifyAppToken(token);
        if (!decoded) return next(ApiError.UnauthorizedError());

        const user = await AppUserModel.findById(decoded.id)
            .populate('role', 'code name isActive')
            .lean();

        if (!user || !user.isActive) {
            return next(ApiError.UnauthorizedError());
        }

        req.appUser = user;
        req.appUserRoleCode = user.role?.code || null;
        req.appUserToken = decoded;
        next();
    } catch (e) {
        return next(ApiError.UnauthorizedError());
    }
};

const appRoleGuard = (allowedCodes = []) => {
    const allowed = new Set(allowedCodes.map(String));
    return (req, res, next) => {
        const code = req.appUserRoleCode || '';
        if (!code || !allowed.has(code)) {
            return next(new ApiError(403, "Sizda bu amal uchun ruxsat yo'q"));
        }
        next();
    };
};

module.exports = appAuthMiddleware;
module.exports.appAuthMiddleware = appAuthMiddleware;
module.exports.appRoleGuard = appRoleGuard;
