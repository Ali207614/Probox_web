'use strict';

const { Schema, model } = require('mongoose');

const RoleSchema = new Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            minlength: 2,
            maxlength: 32,
            match: /^[A-Za-z][A-Za-z0-9_]*$/,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 64,
        },
        description: {
            type: String,
            default: null,
            trim: true,
            maxlength: 255,
        },
        isSystem: {
            type: Boolean,
            default: false,
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

RoleSchema.index({ code: 1 }, { unique: true });

module.exports = model('Role', RoleSchema);
