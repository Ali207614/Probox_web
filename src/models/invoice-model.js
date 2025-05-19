const { Schema, model } = require('mongoose');

const InvoiceSchema = new Schema(
    {
        DocEntry: { type: String, required: false }, // Ichki hujjat raqami
        CardCode: { type: String, required: false }, // Mijoz kodi
        CardName: { type: String, required: false }, // Mijoz nomi
        Dscription: { type: String, required: false }, // Tavsif
        SlpName: { type: String, required: false, default: '' },
        SlpCode: { type: Number, required: false },
        DueDate: { type: Date, required: false },
        newDueDate: { type: Date, required: false },
        IntrSerial: { type: String, required: false },
        InstlmntID: { type: Number, required: false },
        images: [Schema.Types.Mixed],
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

// 👉 Bu yerda indexni qo‘shamiz
InvoiceSchema.index({ SlpCode: 1, DueDate: 1 });

module.exports = model('Invoice', InvoiceSchema);
