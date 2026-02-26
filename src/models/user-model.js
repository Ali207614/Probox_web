
const { Schema, model } = require('mongoose');

const userSchema = new Schema(
    {
        fullName: { type: String },
        chat_id: { type: Number, required: true, unique: true },
        language: { type: String, default: 'uz' },
        user_step: { type: Number, default: 0 },
        back: [{ type: Schema.Types.Mixed, default: [] }],
        select: { type: Schema.Types.Mixed, default: {} },
        phone: { type: String },
        admin: { type: Boolean, default: false },
        status: { type: Boolean, default: false },
        lastMessageId: { type: Number },

        slpCode: { type: Number, default: null },
        slpName: { type: String, default: null },
        slpRole: { type: String, default: null },
        slpBranch: { type: String, default: null },
    },
        { timestamps: true },
);

userSchema.index({ phone: 1 }, { sparse: true });
userSchema.index({ slpCode: 1 }, { sparse: true });
userSchema.index({ language: 1 });
userSchema.index({ user_step: 1 });


module.exports = model('User', userSchema);