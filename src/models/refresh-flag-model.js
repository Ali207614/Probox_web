const { Schema, model } = require('mongoose');

const RefreshFlagSchema = new Schema(
    {
        slpCode: { type: Number, required: true, unique: true, index: true },
        force_refresh: { type: Boolean, default: false },
    },
    { timestamps: true }
);

module.exports = model('RefreshFlag', RefreshFlagSchema);
