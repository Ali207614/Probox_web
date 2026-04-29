'use strict';

const { Schema, model } = require('mongoose');

const AvatarSchema = new Schema(
    {
        keys: {
            small: { type: String, default: null },
            medium: { type: String, default: null },
            large: { type: String, default: null },
        },
    },
    { _id: false }
);

const AppUserSchema = new Schema(
    {
        fullName: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 128,
        },
        phone: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            match: /^998\d{9}$/,
        },
        login: {
            type: String,
            default: null,
            trim: true,
            lowercase: true,
            minlength: 3,
            maxlength: 64,
            match: /^[a-z0-9._-]+$/,
        },
        passwordHash: {
            type: String,
            default: null,
            select: false,
        },
        isRegistered: {
            type: Boolean,
            default: false,
            index: true,
        },
        registeredAt: { type: Date, default: null },
        role: {
            type: Schema.Types.ObjectId,
            ref: 'Role',
            required: true,
            index: true,
        },
        avatar: { type: AvatarSchema, default: null },

        slpCode: { type: Number, default: null, index: true, sparse: true },

        isActive: { type: Boolean, default: true, index: true },
        lastLoginAt: { type: Date, default: null },

        createdBy: { type: Schema.Types.ObjectId, ref: 'AppUser', default: null },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

AppUserSchema.index({ phone: 1 }, { unique: true });
AppUserSchema.index(
    { login: 1 },
    {
        unique: true,
        partialFilterExpression: { login: { $type: 'string' } },
        name: 'uniq_login_when_set',
    }
);

AppUserSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret) => {
        delete ret.passwordHash;
        return ret;
    },
});

module.exports = model('AppUser', AppUserSchema);
