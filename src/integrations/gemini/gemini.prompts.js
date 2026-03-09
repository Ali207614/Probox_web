function buildClosedDiagnosisPrompt({
                                        lead,
                                        reason,
                                        now = new Date(),
                                        tz = 'Asia/Tashkent',
                                        policy,
                                        history,
                                        meta,
                                        allowedReasons = [],
                                    }) {
    const client = lead?.clientName || lead?.clientPhone || lead?.n || lead?._id || 'unknown';
    const today = formatDateInTz(now, tz);
    const minAge = Number(policy?.minAgeInclusive || 21);

    const metaLines = [];
    if (meta?.audioStart) metaLines.push(`- Audio vaqt (taxminiy): ${new Date(meta.audioStart).toISOString()}`);
    if (meta?.closedAt) metaLines.push(`- Lead yopilgan vaqt: ${new Date(meta.closedAt).toISOString()}`);
    if (meta?.from && meta?.to) {
        metaLines.push(`- History window: ${new Date(meta.from).toISOString()} → ${new Date(meta.to).toISOString()}`);
    }

    const metaBlock = metaLines.length ? metaLines.join('\n') : '- Meta: (yo‘q)';
    const historyBlock = `Lead tarixi (kontekst):\n${summarizeHistoryForPrompt(history)}`;
    const reasonsBlock = Array.isArray(allowedReasons) && allowedReasons.length
        ? allowedReasons.map((r) => `- ${r}`).join('\n')
        : '- (ro‘yxat berilmagan)';

    return (
        `Siz call-center sifat nazorati assistentisiz.

Asosiy vazifa:
Operator lead'ni "Closed/Sifatsiz" qilib yopgan. Siz audio suhbatga qarab, leadni yopish qarori TO‘G‘RIMI yoki NOTO‘G‘RIMI ekanini aniqlang.

Eng muhim qoida:
- Asosiy savol: leadni yopish mumkinmidi yoki yo‘qmi?
- Tanlangan rejection reason ikkinchi darajali signal.
- Agar reason unchalik aniq bo‘lmasa ham, yopishning o‘zi to‘g‘ri bo‘lsa, "MOS" deb baholang.
- Faqat reason nomi mos emasligi uchun "MOS EMAS" demang.
- "MOS EMAS" faqat leadni yopish noto‘g‘ri bo‘lsa beriladi.

Quyidagi holatlarda leadni yopish TO‘G‘RI:
- mijoz aniq rad etsa
- "olmayman", "kerak emas", "qiziqmayman" desa
- xarid niyati yo‘qligi aniq bo‘lsa
- boshqa joydan olgan bo‘lsa
- suhbatdan potensial qolmagani aniq ko‘rinsa

Quyidagi holatlarda leadni yopish NOTO‘G‘RI:
- mijoz "o‘ylab ko‘raman" desa
- mijoz "keyinroq qiling", "keyin gaplashamiz" desa
- mijoz "hozir bandman" desa
- mijoz "pasport tashlayman" desa
- mijoz "filialga boraman", "borib ko‘raman" desa
- mijoz narx, muddat, mahsulot haqida qiziqib turgan bo‘lsa
- mijoz potensial bo‘lsa va qayta ishlash mumkin bo‘lsa

Agar leadni yopish NOTO‘G‘RI bo‘lsa, quyidagi eng mos statuslardan bittasini tavsiya qiling:
- Considering
- FollowUp
- WillSendPassport
- WillVisitStore

Status tanlash qoidasi:
- "o‘ylab ko‘raman" -> Considering
- "keyinroq qiling", "hozir bandman" -> FollowUp
- "pasport tashlayman" -> WillSendPassport
- "filialga boraman" -> WillVisitStore

Ruxsat etilgan rejection reasonlar:
${reasonsBlock}

Yosh talabi: age >= ${minAge}
Bugungi sana: ${today} (${tz})

Javob formati aynan quyidagicha bo‘lsin:

1) Qaror: MOS yoki MOS EMAS
2) Yopish sifati: SIFATSIZ (to'g'ri yopilgan) yoki SIFATLI (qayta ishlash kerak)
3) 1-2 ta qisqa dalil
4) Reason bahosi: TO‘G‘RI / QISMAN MOS / NOTO‘G‘RI
5) Agar yopish noto‘g‘ri bo‘lsa, tavsiya status: O'ylab ko'radi / Qayta a'loqa / Passport jo'natadi / Do'konga boradi
6) Agar yopish to‘g‘ri bo‘lsa, qulayroq reason: bitta eng mos sabab. Agar hozirgi sabab yetarli bo‘lsa, "hozirgi sabab qoldirilishi mumkin" deb yozing.

Juda uzun yozmang.

Lead:
- Client: ${client}
- Operator tanlagan reason: ${reason || '(bo‘sh)'}

Meta:
${metaBlock}

${historyBlock}

Audio asosida baholang.`
    );
}


module.exports = {
    buildClosedDiagnosisPrompt
};