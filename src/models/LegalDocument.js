const mongoose = require('mongoose');

const LegalDocumentSchema = new mongoose.Schema(
    {
        entityId: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        template_id: {
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

        createdBy: {
            SlpCode: {
                type: String,
                required: true,
                trim: true,
            },
            SlpName: {
                type: String,
                required: true,
                trim: true,
            },
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

LegalDocumentSchema.index({
    entityId: 1,
    template_id: 1,
    deletedAt: 1,
    createdAt: -1,
});

module.exports = mongoose.model('LegalDocument', LegalDocumentSchema);