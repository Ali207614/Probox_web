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

const SalesPersonProfileSchema = new Schema(
    {
        slpCode: { type: Number, required: true, unique: true, index: true },
        avatar: { type: AvatarSchema, default: null },

        isActive: { type: Boolean, default: true, index: true },
        isDeleted: { type: Boolean, default: false, index: true },

        deactivatedAt: { type: Date, default: null },
        deactivatedBy: { type: Number, default: null }, // SlpCode

        deletedAt: { type: Date, default: null },
        deletedBy: { type: Number, default: null }, // SlpCode
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

SalesPersonProfileSchema.index({ isDeleted: 1, isActive: 1 });

module.exports = model('SalesPersonProfile', SalesPersonProfileSchema);
