const { Schema, model } = require('mongoose');
const LeadChatSchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },

        // ✅ PBX meta
        pbx: {
            uuid: { type: String, index: true },
            gateway: { type: String },
            accountcode: { type: String }, // inbound/outbound/missed...
            start_stamp: { type: Number },
            end_stamp: { type: Number },
            operator_ext: { type: String },
            client_phone: { type: String },
        },

        Audio: {
            url: { type: String, required: false },      // response’da qo'yamiz (expiring)
            duration: { type: Number, required: false }, // user_talk_time yoki duration
        },

        createdBy: { type: Number, required: true, trim: true },
        message: { type: String, required: true, trim: true },

        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date, default: null },
        deletedBy: { type: Number, default: null, index: true },
        deletedByRole: { type: String, default: null },
    },
    { timestamps: true }
);

// ✅ duplicate bo‘lmasin (leadId + pbx.uuid unique)
LeadChatSchema.index(
    { leadId: 1, 'pbx.uuid': 1 },
    { unique: true, partialFilterExpression: { 'pbx.uuid': { $exists: true } } }
);
module.exports = model('LeadChat', LeadChatSchema);