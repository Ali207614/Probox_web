'use strict';

function formatDateInTz(date = new Date(), timeZone = 'Asia/Tashkent') {
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

function safeOneLine(text, max = 220) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/**
 * History’ni Gemini uchun “kuchli signal” formatda qisqartiramiz:
 * - status_changed / operator_changed / field_changed (rejectionReason...) birinchi o’rinda
 * - call_* eventlar
 * - chat message (operator comment)
 */
function summarizeHistoryForPrompt(items = []) {
    const out = [];
    const list = Array.isArray(items) ? items : [];

    for (const it of list) {
        const t = it.createdAt ? new Date(it.createdAt).toISOString() : '';
        const type = it.type || '';
        const action = it.action || '';

        // changes qisqa
        let changesLine = '';
        if (Array.isArray(it.changes) && it.changes.length) {
            const important = it.changes
                .filter(c => c?.field)
                .slice(0, 4)
                .map(c => {
                    const f = c.field;
                    const from = safeOneLine(c.from, 50);
                    const to = safeOneLine(c.to, 50);
                    return `${f}:${from}→${to}`;
                })
                .join(', ');
            if (important) changesLine = ` | changes: ${important}`;
        }

        // pbx qisqa
        let pbxLine = '';
        if (it.pbx?.uuid) {
            const outcome = it.pbx?.outcome || 'unknown';
            const dur = it.pbx?.dialog_duration != null ? ` dur:${it.pbx.dialog_duration}` : '';
            pbxLine = ` | pbx:${it.pbx.uuid} (${outcome})${dur}`;
        }

        // message qisqa
        const msg = safeOneLine(it.message, 220);

        // eventlarni prioritet qilamiz: status/reason/operator/call
        const isImportantEvent =
            type === 'event' &&
            (action === 'status_changed' ||
                action === 'operator_changed' ||
                action === 'field_changed' ||
                action.startsWith('call_') ||
                action === 'auto_closed');

        const isChat = type === 'chat';

        // chat ham kerak bo’lishi mumkin (operator comment)
        if (isImportantEvent || isChat) {
            out.push(`- ${t} ${type}/${action}: ${msg}${changesLine}${pbxLine}`);
        }

        if (out.length >= 18) break; // ✅ limit: token tejash
    }

    return out.length ? out.join('\n') : '(history yo‘q)';
}

function buildClosedDiagnosisPrompt({
                                        lead,
                                        reason,
                                        now = new Date(),
                                        tz = 'Asia/Tashkent',
                                        policy,
                                        history,
                                        meta,
                                    }) {
    const client = lead?.clientName || lead?.clientPhone || lead?.n || lead?._id || 'unknown';
    const today = formatDateInTz(now, tz);

    const minAge = Number(policy?.minAgeInclusive || 21);

    const metaLines = [];
    if (meta?.audioStart) metaLines.push(`- Audio vaqt (taxminiy): ${new Date(meta.audioStart).toISOString()}`);
    if (meta?.closedAt) metaLines.push(`- Lead yopilgan vaqt: ${new Date(meta.closedAt).toISOString()}`);
    if (meta?.from && meta?.to)
        metaLines.push(`- History window: ${new Date(meta.from).toISOString()} → ${new Date(meta.to).toISOString()}`);

    const metaBlock = metaLines.length ? metaLines.join('\n') : '- Meta: (yo‘q)';

    const historyBlock = `Lead tarixi (kontekst):\n${summarizeHistoryForPrompt(history)}`;

    return (
        `Siz call-center sifat nazorati assistentisiz.
Vazifa: operator lead'ni "Closed/Sifatsiz" qilib yopgan. Operator tanlagan Rejection reason audio suhbatga MOS keladimi?

Qoidalar (juda muhim):
- MOS/MOS EMAS xulosasi faqat audio mazmuniga tayanadi.
- Lead tarixi faqat kontekst: reason nomini to‘g‘ri tanlash, vaqtlarni tushunish va yoshni hisoblashda yordam beradi.
- Yosh talabi: age >= ${minAge} (ya'ni ${minAge} yoshga teng yoki katta).
- Bugungi sana (hisoblash uchun): ${today} (${tz})
- Agar audio’da tug‘ilgan yil/sana aytilsa: yoshni yuqoridagi sana bo‘yicha hisoblab tekshiring.
- Agar faqat tug‘ilgan yil aytilsa (oy-kun yo‘q): ehtimoliy yosh diapazonini yozing va "aniq emas" deb qayd eting.
- Javob 4 qismdan iborat bo'lsin:

  1) "MOS" yoki "MOS EMAS"
  2) 1-2 ta qisqa dalil (audio mazmunidan)
  3) Tavsiya: "SIFATSIZ (to'g'ri yopilgan)" yoki "SIFATLI (qayta ishlash kerak)"
  4) Agar reason noto'g'ri bo'lsa, mos bo'lgan 1-2 alternativ reason yozing.
- Juda uzun yozmang.

Lead:
- Client: ${client}
- Operator set reason: ${reason || '(bo‘sh)'}

Meta:
${metaBlock}

${historyBlock}

Audio asosida analiz qiling.`
    );
}

module.exports = {
    buildClosedDiagnosisPrompt,
    formatDateInTz,
};