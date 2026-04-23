const ApiError = require('../exceptions/api-error');

module.exports = function (allowedRoles = []) {
    const allowed = new Set(allowedRoles);
    return function (req, res, next) {
        const role = req.user?.U_role;
        if (!role || !allowed.has(role)) {
            return next(new ApiError(403, "Sizda ruxsat yo'q"));
        }
        next();
    };
};
