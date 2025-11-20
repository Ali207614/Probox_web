const { Schema, model } = require('mongoose');

const LeadImageSchema = new Schema(
    {
        leadId: {
            type: Schema.Types.ObjectId,
            ref: 'Lead',
            required: true,
            index: true,
        },

        cardCode: {
            type: String,
            index: true,
        },

        keys: {
            small: { type: String, required: true },
            medium: { type: String, required: true },
            large: { type: String, required: true },
        },

        fileName: String,
        mimeType: String,
        size: Number,
    },
    { timestamps: true }
);

module.exports = model('LeadImage', LeadImageSchema);
