const { Schema, model } = require('mongoose');

const CommentSchema = new Schema(
    {
        DocEntry: { type: String, required: false },
        Comments: { type: String, required: false },
        Image: { type: String, required: false },
        Audio: { type: String, required: false },
        SlpCode: { type: Number, required: false },
        DocDate: { type: Date, required: false },
        InstlmntID: { type: Number, required: false },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

module.exports = model('Comment', CommentSchema);
