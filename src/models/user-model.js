const { Schema, model } = require('mongoose');

const UserSchema = new Schema(
    {
        CardCode: { type: String, required: false },
        CardName: { type: String, required: false },
        Lat: { type: String, required: false },
        Long: { type: String, required: false },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

module.exports = model('User', UserSchema);
