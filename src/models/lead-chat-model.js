const { Schema, model } = require('mongoose');

const LeadChatSchema = new Schema(
    {
        leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },

        /**
         * ✅ 1) RECORD TYPE
         * - chat: operator/user yozgan matn
         * - event: tizim yoki user qilgan harakat (status change, call, operator change...)
         */
        type: {
            type: String,
            enum: ['chat', 'event'],
            default: 'chat',
            index: true,
        },

        /**
         * ✅ 2) EVENT ACTION (faqat type=event bo'lsa)
         * 1 update = 1 event bo'lishi uchun har update’da bitta action yoziladi.
         */
        action: {
            type: String,
            enum: [
                // lead lifecycle
                'lead_created',
                'lead_updated',

                // changes
                'status_changed',
                'operator_changed',
                'field_changed',

                // phone/call
                'call_started',
                'call_answered',
                'call_no_answer',
                'call_missed',
                'call_ended',

                // auto/system actions
                'auto_closed',
                'auto_ignored',

                // optional
                'note',
            ],
            default: null,
            index: true,
        },

        /**
         * ✅ 3) WHO DID IT
         * - createdBy: kim qilgan (user/admin/operator id)
         * - agar system bo'lsa: createdBy 0 (yoki null) + isSystem=true
         */
        createdBy: { type: Number, required: true, trim: true, index: true }, // sizda required edi, shuni saqlaymiz
        createdByRole: { type: String, default: null, index: true }, // Seller / Operator / Admin / System
        isSystem: { type: Boolean, default: false, index: true },

        /**
         * ✅ 4) MAIN TEXT (UI uchun)
         * Chat bo'lsa: message - operator yozgan text
         * Event bo'lsa: message - "Status changed: Active → Closed" kabi qisqa text
         */
        message: { type: String, required: true, trim: true },

        /**
         * ✅ 5) CHANGES (1 update = 1 event uchun eng muhim qism)
         * Nimasi o'zgarganini saqlaymiz: from/to.
         * Masalan status, operator, rejectionReason, meetingDate, callCount...
         */
        changes: [
            {
                field: { type: String, required: true },
                from: { type: Schema.Types.Mixed, default: null },
                to: { type: Schema.Types.Mixed, default: null },
            },
        ],

        /**
         * ✅ 6) CALL META (PBX)
         * Har telefon voqeasi shu yerga tushadi:
         * - inbound/outbound
         * - answered/noAnswer/missed
         * - duration
         * - operator ext / slpCode
         */
        pbx: {
            uuid: { type: String, index: true },
            gateway: { type: String, default: null },
            accountcode: { type: String, default: null }, // inbound/outbound/missed... (PBX dan kelsa)
            direction: { type: String, enum: ['inbound', 'outbound', null], default: null, index: true },

            start_stamp: { type: Number, default: null }, // unix stamp bo'lsa
            end_stamp: { type: Number, default: null },

            operator_ext: { type: String, default: null },
            operator_slpCode: { type: Number, default: null, index: true },

            client_phone: { type: String, default: null },

            // call outcome
            outcome: {
                type: String,
                enum: ['answered', 'no_answer', 'missed', 'unknown', null],
                default: null,
                index: true,
            },

            dialog_duration: { type: Number, default: null }, // sekund yoki ms (siz qanday ishlatsangiz)
        },

        /**
         * ✅ 7) AUDIO META (agar recording bo'lsa)
         */
        audio: {
            url: { type: String, default: null },
            duration: { type: Number, default: null },
        },

        /**
         * ✅ 8) OPTIONAL: status/operator snapshot (UIga qulay)
         * O'zgarish eventlarida tez ko'rish uchun.
         */
        statusFrom: { type: String, default: null, index: true },
        statusTo: { type: String, default: null, index: true },

        operatorFrom: { type: Number, default: null, index: true },
        operatorTo: { type: Number, default: null, index: true },

        /**
         * ✅ soft delete
         */
        isDeleted: { type: Boolean, default: false, index: true },
        deletedAt: { type: Date, default: null },
        deletedBy: { type: Number, default: null, index: true },
        deletedByRole: { type: String, default: null },
    },
    { timestamps: true }
);

/**
 * ✅ INDEXES
 * 1) Feed tez ochilishi uchun: leadId + createdAt
 */
LeadChatSchema.index({ leadId: 1, createdAt: -1 });

/**
 * ✅ Duplicate bo‘lmasin (leadId + pbx.uuid unique)
 * Sizning oldingi index’ingizni saqlaymiz.
 */
LeadChatSchema.index(
    { leadId: 1, 'pbx.uuid': 1 },
    {
        unique: true,
        partialFilterExpression: { 'pbx.uuid': { $type: 'string', $ne: '' } },
    }
);





module.exports = model('LeadChat', LeadChatSchema);
