const ApiError = require('../exceptions/api-error');
const tokenService = require('../services/tokenService');

module.exports = async function (req, res, next) {
    try {
        const accessToken = req.headers?.authorization;

        if (!accessToken) {
            return next(ApiError.UnauthorizedError());
        }

        // Tokenni tekshirish
        const userData = tokenService.validateAccessToken(accessToken);
        if (!userData) {
            return next(ApiError.UnauthorizedError());
        }

        req.user = userData;
        next();
    } catch (e) {
        return next(ApiError.UnauthorizedError());
    }
};
