const { Schema, model } = require('mongoose');

const VerificationCodeSchema = new Schema({
    phone: { type: String, required: true, index: true },
    code: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 300 }
});

module.exports = model('VerificationCode', VerificationCodeSchema);