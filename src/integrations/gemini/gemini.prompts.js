'use strict';

function formatDateInTz(date = new Date(), timeZone = 'Asia/Tashkent') {
    // YYYY-MM-DD format
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);

    const y = parts.find(p => p.type === 'year')?.value;
    const m = parts.find(p => p.type === 'month')?.value;
    const d = parts.find(p => p.type === 'day')?.value;

    return `${y}-${m}-${d}`;
}

function buildClosedDiagnosisPrompt({ lead, reason, now = new Date() }) {
    const client = lead?.clientName || lead?.clientPhone || lead?.n || lead?._id || 'unknown';

    const TZ = 'Asia/Tashkent';
    const TODAY = formatDateInTz(now, TZ);

    return (
        `Siz call-center sifat nazorati assistentisiz.
Vazifa: operator lead'ni "Closed/Sifatsiz" qilib yopgan. Operator tanlagan Rejection reason audio suhbatga MOS keladimi?

Muhim kontekst:
- Yosh talabi: mijozning yoshi 21 yoshga TENG yoki KATTA bo‘lishi kerak (age >= 21).
- Bugungi sana (hisoblash uchun): ${TODAY} (${TZ})

Qoidalar:
- Faqat audio mazmuniga tayaning.
- Agar audio’da tug‘ilgan yil yoki tug‘ilgan sana aytilsa, yoshni yuqoridagi sana bo‘yicha hisoblab tekshiring.
- Agar tug‘ilgan kun (oy-kun) aytilmagan bo‘lsa, faqat tug‘ilgan yilga qarab ehtimoliy yosh diapazonini yozing va "aniq emas" deb qayd eting.
- Javob 4 qismdan iborat bo'lsin:
  1) "MOS" yoki "MOS EMAS"
  2) 1-2 ta qisqa dalil (audio mazmunidan)
  3) Tavsiya: "SIFATSIZ (to'g'ri yopilgan)" yoki "SIFATLI (qayta ishlash kerak)"
  4) Agar reason noto'g'ri bo'lsa, mos bo'lgan 1-2 alternativ reason yozing.
- Juda uzun yozmang.

Lead:
- Client: ${client}
- Operator set reason: ${reason || '(bo‘sh)'}

Audio asosida analiz qiling.`
    );
}

module.exports = {
    buildClosedDiagnosisPrompt,
};