// models/plan-model.js

const { Schema, model } = require('mongoose');

/**
 * Funnel plan (reja) qiymatlari.
 *
 * Period formati:
 *  - 'YYYY-MM'                       -> oylik plan (masalan: '2026-01')
 *  - 'YYYY-MM-DD_YYYY-MM-DD'         -> aniq diapazon plan
 *
 * Controller avval aniq diapazon kaliti bo'yicha qidiradi, topilmasa
 * boshlang'ich sananing oylik kaliti bo'yicha qidiradi.
 */
const PlanSchema = new Schema(
    {
        period: { type: String, required: true, unique: true, index: true },

        // Funnel bosqichlari (absolute qiymatlar)
        lead:            { type: Number, default: 0 }, // 1. Lead
        qualityLead:     { type: Number, default: 0 }, // 2. Sifatli lead
        scoringApproved: { type: Number, default: 0 }, // 9. Skoringdan tasdiqlandi
        meetingSet:      { type: Number, default: 0 }, // 10. Tashrif belgilandi
        willVisitStore:  { type: Number, default: 0 }, // 11. Do'konga boradi
        meetingHappened: { type: Number, default: 0 }, // 12. Tashrif o'tkazildi
        visitedStore:    { type: Number, default: 0 }, // 13. Do'konga keldi
        contractSigned:  { type: Number, default: 0 }, // 14. Shartnoma oldi

        // Moliyaviy
        salesAmount:     { type: Number, default: 0 }, // Sotuv summasi
        averageCheck:    { type: Number, default: 0 }, // O'rtacha chek

        note:            { type: String, default: null }
    },
    { timestamps: true }
);

module.exports = model('Plan', PlanSchema);