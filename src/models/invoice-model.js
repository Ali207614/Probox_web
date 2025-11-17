const { Schema, model } = require('mongoose');

const InvoiceSchema = new Schema(
    {
        DocEntry: { type: String, required: false }, 
        CardCode: { type: String, required: false },
        CardName: { type: String, required: false },
        Dscription: { type: String, required: false },
        SlpName: { type: String, required: false, default: '' },
        SlpCode: { type: Number, required: false },
        DueDate: { type: Date, required: false },
        newDueDate: { type: Date, required: false },
        IntrSerial: { type: String, required: false },
        InstlmntID: { type: Number, required: false },
        InsTotal: { type: Number, required: false },
        phoneConfiscated: { type: Boolean, default: false },
        partial: { type: Boolean, default: false },
        newTime: { type: Date, required: false },
        notificationSent: { type: Boolean, required: false },
        images: [Schema.Types.Mixed],
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

InvoiceSchema.index({ SlpCode: 1, DueDate: 1 });

module.exports = model('Invoice', InvoiceSchema);
