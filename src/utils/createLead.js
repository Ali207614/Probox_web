const moment = require('moment');

const LeadModel = require("../models/lead-model");

function parseSheetDate(value) {
    if (!value) {
        return moment().utcOffset(5).toDate(); // bugungi sana
    }

    // Excel serial date bo‘lsa
    if (!isNaN(value)) {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        return new Date(excelEpoch.getTime() + value * 86400000);
    }

    // Matn ko‘rinishidagi sana
    const str = String(value).trim().replace(/\//g, '.');
    let parsed = moment(str, ['DD.MM.YYYY HH:mm:ss', 'DD.MM.YYYY HH:mm', 'DD.MM.YYYY'], true);

    // Faqat sana bo‘lsa → hozirgi vaqtni qo‘shamiz
    if (parsed.isValid() && /^\d{2}\.\d{2}\.\d{4}$/.test(str)) {
        const now = moment();
        parsed.set({
            hour: now.hour(),
            minute: now.minute(),
            second: now.second(),
        });
    }

    // Noto‘g‘ri bo‘lsa → bugungi sana
    if (!parsed.isValid()) {
        return moment().utcOffset(5).toDate();
    }

    // To‘g‘ri vaqtni +05:00 offset bilan
    return parsed.utcOffset(5).toDate();
}

async function generateShortId(prefix = 'PRO') {
    // 1️⃣ Eng oxirgi leadni topamiz
    const lastLead = await LeadModel
        .findOne({ n: new RegExp(`^${prefix}`) }) // faqat PRO bilan boshlanganlar
        .sort({ createdAt: -1 })
        .select('n')
        .lean();

    if (!lastLead?.n) {
        return `${prefix}00001`;
    }

    const lastNumber = parseInt(lastLead.n.replace(prefix, ''), 10);

    const nextNumber = lastNumber + 1;

    const formatted = String(nextNumber).padStart(5, '0');

    // 6️⃣ Natija qaytarish
    return `${prefix}${formatted}`;
}



module.exports = { parseSheetDate , generateShortId };