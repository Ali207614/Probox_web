'use strict';

const { Schema, model } = require('mongoose');

const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS || 300);

const OtpCodeSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'AppUser',
            required: true,
            index: true,
        },
        purpose: {
            type: String,
            enum: [
                'register',
                'reset_password',
                'change_login',
                'change_password',
                'change_credentials',
            ],
            required: true,
        },
        codeHash: { type: String, required: true },
        attempts: { type: Number, default: 0 },
        usedAt: { type: Date, default: null },
        createdAt: { type: Date, default: () => new Date() },
        expiresAt: {
            type: Date,
            required: true,
            index: { expires: 0 },
        },
    },
    { versionKey: false }
);

OtpCodeSchema.index({ userId: 1, purpose: 1, usedAt: 1 });

OtpCodeSchema.statics.TTL_SECONDS = OTP_TTL_SECONDS;

module.exports = model('OtpCode', OtpCodeSchema);
