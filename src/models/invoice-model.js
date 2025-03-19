const { Schema, model } = require('mongoose');

const InvoiceSchema = new Schema(
    {
        DocEntry: { type: String, required: false }, // Ichki hujjat raqami
        DueDate: { type: Date, required: false }, // Hujjat sanasi
        CardCode: { type: String, required: false }, // Mijoz kodi
        CardName: { type: String, required: false }, // Mijoz nomi
        Dscription: { type: String, required: false }, // Tavsif
        Balance: { type: Number, required: false }, // Qoldiq summa
        Phone1: { type: String, required: false }, // Telefon raqami
        Phone2: { type: String, required: false }, // Telefon raqami
        DocTotal: { type: Number, required: false }, // Hujjat umumiy summasi
        PaidToDate: { type: Number, required: false }, // To'langan summa,
        SlpCode: { type: String, required: false, default: null },
        TotalPaidToDate: { type: Number, required: false },
        Installmnt: { type: Number, required: false },
        IntrSerial: { type: String, required: false },
        InstlmntID: { type: Number, required: false },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

module.exports = model('Invoice', InvoiceSchema);
