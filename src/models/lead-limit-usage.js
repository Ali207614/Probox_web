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

        snapshot: {
            finalLimit: { type: Number, default: null },
            internalLimit: { type: Number, default: null },
            percentage: { type: Number, default: null },
            currency: { type: String, default: 'UZS' },
        },

        usedAmount: { type: Number, required: true, min: 0 },

        actor: {
            type: { type: String, enum: ['user', 'admin', 'system'], default: 'system' },
            id: { type: String, default: null }, // userId/adminId (string)
            name: { type: String, default: null },
        },

        reason: { type: String, default: null }, // ixtiyoriy: manual/scoring/rule
    },
    { timestamps: true }
);

module.exports = model('LeadLimitUsage', LeadLimitUsageSchema);
