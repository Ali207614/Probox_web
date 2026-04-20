const { Schema, model } = require('mongoose');

const ReservationSchema = new Schema(
    {
        leadId: {
            type: Schema.Types.ObjectId,
            ref: 'Lead',
            required: true,
            index: true,
        },

        itemCode: { type: String, required: true, trim: true },
        itemName: { type: String, default: null, trim: true },
        imei: { type: String, required: true, trim: true, index: true },
        warehouseCode: { type: String, default: null, trim: true },
        quantity: { type: Number, default: 1, min: 1 },

        reservedBy: { type: Number, default: null },
        reservedByName: { type: String, default: null },
        reservedByRole: { type: String, default: null },

        status: {
            type: String,
            enum: ['active', 'released', 'expired', 'consumed'],
            default: 'active',
            index: true,
        },
        releaseReason: {
            type: String,
            enum: [null, 'manual', 'purchased', 'no_purchase', 'closed', 'blocked', 'expired'],
            default: null,
        },
        releasedBy: { type: Number, default: null },
        releasedByName: { type: String, default: null },
        releasedByRole: { type: String, default: null },
        releasedAt: { type: Date, default: null },

        reservedAt: { type: Date, default: () => new Date() },
        expiresAt: { type: Date, required: true },
    },
    {
        timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    }
);

ReservationSchema.index(
    { imei: 1 },
    {
        unique: true,
        partialFilterExpression: { status: 'active' },
        name: 'uniq_active_imei',
    }
);

ReservationSchema.index({ leadId: 1, status: 1 });
ReservationSchema.index({ status: 1, expiresAt: 1 });

module.exports = model('Reservation', ReservationSchema);
