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
            small: {
                type: String,
                required: function () { return this.isPdf === false; }
            },
            medium: {
                type: String,
                required: function () { return this.isPdf === false; }
            },
            large: {
                type: String,
                required: function () { return this.isPdf === false; }
            },
        },
        pdfKey: { type: String },
        isPdf: { type: Boolean, default: false },
        fileName: String,
        mimeType: String,
        size: Number,
    },
    { timestamps: true }
);

module.exports = model('LeadImage', LeadImageSchema);
