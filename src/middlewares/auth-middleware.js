const ApiError = require('../exceptions/api-error');
const tokenService = require('../services/tokenService');
const SessionToken = require('../models/session-token-model');

module.exports = async function (req, res, next) {
    try {
        const accessToken = req.headers?.authorization;

        if (!accessToken) {
            return next(ApiError.UnauthorizedError());
        }

        const userData = tokenService.validateAccessToken(accessToken);
        if (!userData) {
            return next(ApiError.UnauthorizedError());
        }

        const slpCode = userData.SlpCode ?? userData.id;
        if (slpCode == null || !userData.jti) {
            return next(ApiError.UnauthorizedError());
        }

        const session = await SessionToken.findOne({ slpCode }).lean();
        if (!session || session.jti !== userData.jti) {
            return next(ApiError.UnauthorizedError());
        }

        req.user = userData;
        next();
    } catch (e) {
        return next(ApiError.UnauthorizedError());
    }
};
