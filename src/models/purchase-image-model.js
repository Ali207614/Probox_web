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

        // mijozning to'liq ismi: Familiya Ism Otasining ismi
        fio: { type: String, default: null, trim: true },
        invoiceSum: { type: Number, default: null },
        // shartnoma muddati (oy hisobida, masalan: 11, 12)
        term: { type: Number, default: null, min: 1, max: 60 },
        productName: { type: String, default: null },
        downPayment: { type: Number, default: null },
        monthlyPayment: { type: Number, default: null },

        deletedAt: {
            type: Date,
            default: null,
            index: true,
        },
    },
    { timestamps: true }
);


module.exports = model('PurchasePdf', PurchasePdfSchema);
