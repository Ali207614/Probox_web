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
        },
        isDeleted: {
            type: Boolean,
            default: false,
            index: true,
        },
        deletedAt: {
            type: Date,
            default: null,
        },
        deletedBy: {
            type: Number, // kim o‘chirdi (SlpCode)
            default: null,
            index: true,
        },
        deletedByRole: {
            type: String, // optional: "Admin" / "User" etc.
            default: null,
        },
    },
    { timestamps: true } // createdAt, updatedAt
);

module.exports = mongoose.model('LeadChat', LeadChatSchema);
