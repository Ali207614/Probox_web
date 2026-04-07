const { Schema, model } = require('mongoose');

const PurchasePdfSchema = new Schema(
    {
        docEntry: {
            type: Number,
            required: true,
            index: true,
        },

        cardCode: {
            type: String,
            index: true,
            default: null,
        },

        docNum: {
            type: String,
            default: null,
            index: true,
        },

        pdfKey: {
            type: String,
            required: true,
        },

        fileName: { type: String, required: true },
        mimeType: { type: String, required: true }, // application/pdf
        size: { type: Number, required: true },

        deletedAt: {
            type: Date,
            default: null,
            index: true,
        },
    },
    { timestamps: true }
);


module.exports = model('PurchasePdf', PurchasePdfSchema);
