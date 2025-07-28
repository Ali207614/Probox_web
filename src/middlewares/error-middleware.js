const ApiError = require('../exceptions/api-error');
const multer = require('multer');
module.exports = function (err, req, res, next) {
    if (err instanceof ApiError) {
        return res.status(err.status).json({ message: err.message, errors: err.errors })
    }

    else if (err instanceof multer.MulterError || err.message === 'Invalid file type') {
        return res.status(400).json({ message: err.message });
    }

    return res.status(500).json({ message: 'Непредвиденная ошибка' })

};
