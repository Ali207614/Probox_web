const { Schema, model } = require('mongoose');

const SessionTokenSchema = new Schema(
    {
        slpCode: { type: Number, required: true, unique: true, index: true },
        jti: { type: String, required: true },
    },
    { timestamps: true }
);

module.exports = model('SessionToken', SessionTokenSchema);
