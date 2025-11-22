const mongoose = require('mongoose');
const { Schema } = mongoose;

const LeadChatSchema = new Schema(
    {
        leadId: {
            type: Schema.Types.ObjectId,
            ref: 'Lead',
            required: true,
        },
        createdBy: {
            type: Number,
            required: true,
            trim: true,
        },
        message: {
            type: String,
            required: true,
            trim: true,
        }
    },
    { timestamps: true } // createdAt, updatedAt
);

module.exports = mongoose.model('LeadChat', LeadChatSchema);
