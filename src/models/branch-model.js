const { Schema, model } = require('mongoose');

const BranchSchema = new Schema(
    {
        id: {
            type: Number,
            required: true,
        },
        code: {
            type: String,
            required: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            description: 'Filial nomi (masalan, Tashkent, Samarkand, Fergana)',
        },
        region: {
            type: String,
            trim: true,
            description: 'Viloyat nomi',
        },
        address: {
            type: String,
            trim: true,
            description: 'Filial manzili',
        },
        phone: {
            type: String,
            trim: true,
            description: 'Filial telefon raqami',
        },
    },
    { timestamps: true }
);

module.exports = model('Branch', BranchSchema);
