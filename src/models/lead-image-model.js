const { Schema, model } = require('mongoose');

const LeadImageSchema = new Schema(
    {
        cardCode: {
            type: String,
            required: true,
            index: true,
            description: 'Lead yoki mijozning CardCode qiymati',
        },
        key: {
            type: String,
            required: true,
            description: 'MinIO ichidagi object key (path)',
        },
        url: {
            type: String,
            required: true,
            description: 'Presigned yoki public URL',
        },
        fileName: {
            type: String,
            description: 'Asl fayl nomi (client tomonidan yuborilgan)',
        },
        mimeType: {
            type: String,
            description: 'MIME turi (image/jpeg, image/png, va hokazo)',
        },
        size: {
            type: Number,
            description: 'Fayl hajmi baytlarda',
        },
    },
    { timestamps: true }
);

module.exports = model('LeadImage', LeadImageSchema);
