const { Schema, model } = require('mongoose');


const LeadLimitUsageSchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
        usedType: {
            type: String,
            required: true,
            enum: ['finalLimit', 'internalLimit', 'percentage'],
            index: true,
        },
        month: { type: String },
        firstPayment: { type: String },

        snapshot: {
            finalLimit: { type: Number, default: null },
            internalLimit: { type: Number, default: null },
            percentage: { type: Number, default: null },
            currency: { type: String, default: 'UZS' },
        },

        usedAmount: { type: Number, required: true, min: 0 },

        actor: {
            type: { type: String,default: null },
            id: { type: String, default: null }, // userId/adminId (string)
            cardCode: { type: String, default: null }, // userId/adminId (string)
            name: { type: String, default: null },
            jshshir: { type: String, default: null },
            passportId: { type: String, default: null },
        },

        reason: { type: String, default: null }, // ixtiyoriy: manual/scoring/rule
    },
    { timestamps: true }
);

module.exports = model('LeadLimitUsage', LeadLimitUsageSchema);
