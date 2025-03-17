const { Schema, model } = require('mongoose');

const InvoiceSchema = new Schema(
    {
        DocEntry: { type: String, required: false }, // Ichki hujjat raqami
        DocDate: { type: Date, required: false }, // Hujjat sanasi
        CardCode: { type: String, required: false }, // Mijoz kodi
        CardName: { type: String, required: false }, // Mijoz nomi
        Dscription: { type: String, required: false }, // Tavsif
        Balance: { type: Number, required: false }, // Qoldiq summa
        Phone1: { type: String, required: false }, // Telefon raqami
        DocTotal: { type: Number, required: false }, // Hujjat umumiy summasi
        PaidToDate: { type: Number, required: false }, // To'langan summa,
        SlpCode: { type: Number, required: false },
        TotalPaidToDate: { type: Number, required: false },
        Installmnt: { type: Number, required: false },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

module.exports = model('Invoice', InvoiceSchema);
