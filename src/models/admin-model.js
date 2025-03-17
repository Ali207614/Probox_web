const { Schema, model } = require('mongoose');

const AdminSchema = new Schema(
    {
        name: { type: String, required: false },
        phone: { type: String, required: false },
        login: { type: String, required: true },
        password: { type: String, required: true },
        role: [{ type: Schema.Types.ObjectId, ref: "Role" }], // ['ADMIN',]
        branch: [{ type: Schema.Types.ObjectId, ref: "Branch" }],
        is_active: { type: Boolean, default: true },
        status: { type: String, enum: ['Open', 'Deleted'], default: 'Open' }
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
    }
);

module.exports = model('Admin', AdminSchema);
