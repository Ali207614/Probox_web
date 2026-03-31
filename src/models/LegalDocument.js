const mongoose = require('mongoose');

const LegalDocumentSchema = new mongoose.Schema(
    {
        entityId: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        doc_name: {
            type: String,
            required: true,
            trim: true,
        },

        fileName: {
            type: String,
            required: true,
            trim: true,
        },

        mimeType: {
            type: String,
            required: true,
            trim: true,
        },

        size: {
            type: Number,
            required: true,
        },

        key: {
            type: String,
            required: true,
            trim: true,
        },

        deletedAt: {
            type: Date,
            default: null,
            index: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

module.exports = mongoose.model('LegalDocument', LegalDocumentSchema);