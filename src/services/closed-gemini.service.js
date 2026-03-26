'use strict';

const LeadModel = require('../models/lead-model');
const { geminiGenerateContent } = require('../integrations/gemini/gemini.client');
const { buildClosedDiagnosisPrompt } = require('../integrations/gemini/gemini.prompts');
const { getLastTalkedCallUuidForLead } = require('../integrations/pbx/pbx-last-talked.util');
const { downloadRecordingAsBase64 } = require('../integrations/pbx/pbx-recording.util');
const { buildClosedContextWindow } = require('../integrations/gemini/gemini.context.util');
const { escapeHtml } = require('../utils/text.util');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MAX_AUDIO_MB = Number(process.env.GEMINI_MAX_AUDIO_MB || 8);

// Cache TTL
const GEMINI_CACHE_TTL_MS = Number(process.env.GEMINI_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);

// Context sozlamalar
const TZ = process.env.TZ || 'Asia/Tashkent';
const MIN_AGE_INCLUSIVE = Number(process.env.CLOSED_MIN_AGE_INCLUSIVE || 21);
const CONTEXT_BUFFER_MIN = Number(process.env.GEMINI_CONTEXT_BUFFER_MIN || 180); // 3 soat
const CONTEXT_LIMIT = Number(process.env.GEMINI_CONTEXT_LIMIT || 80);

async function getGeminiClosedAnalysisLine({ pbxClient, trunkNames, leadId, reason, now = new Date() }) {
    const lead = await LeadModel.findById(leadId)
        .select('clientPhone time newTime clientName n closedGeminiAt closedGeminiUuid closedGeminiText')
        .lean();

    if (!lead) return '🤖 GEMINI: lead topilmadi';

    // 1) cache
    const cachedAt = lead.closedGeminiAt ? new Date(lead.closedGeminiAt).getTime() : 0;
    const cachedOk = lead.closedGeminiText && cachedAt && (Date.now() - cachedAt) < GEMINI_CACHE_TTL_MS;
    if (cachedOk) return `🤖 <b>GEMINI:</b> ${escapeHtml(lead.closedGeminiText)}`;

    // 2) last talked uuid (trunkNames uzatildi)
    const lastUuid = await getLastTalkedCallUuidForLead({ pbxClient, trunkNames, lead });
    if (!lastUuid) {
        const text = 'audio topilmadi (talk_time > 0 yo‘q)';
        await LeadModel.updateOne(
            { _id: leadId },
            { $set: { closedGeminiAt: new Date(), closedGeminiUuid: null, closedGeminiText: text } }
        );
        return `🤖 GEMINI: ${escapeHtml(text)}`;
    }

    // 3) agar shu uuid bilan oldin analiz bo’lgan bo’lsa
    if (lead.closedGeminiUuid && String(lead.closedGeminiUuid) === String(lastUuid) && lead.closedGeminiText) {
        return `🤖 <b>GEMINI:</b> ${escapeHtml(lead.closedGeminiText)}`;
    }

    // 4) ✅ context window (trunkNames uzatildi)
    const ctx = await buildClosedContextWindow({
        pbxClient,
        trunkNames,
        leadId,
        uuid: lastUuid,
        bufferMin: CONTEXT_BUFFER_MIN,
        limit: CONTEXT_LIMIT,
        now,
    });

    // 5) audio yuklash (Edge-case tekshiruvi bilan)
    let audio;
    try {
        audio = await downloadRecordingAsBase64({
            pbxClient,
            uuid: lastUuid,
            maxMb: GEMINI_MAX_AUDIO_MB,
        });
    } catch (err) {
        console.error(`[Gemini Audio Error] Lead: ${leadId}`, err.message);
        return `🤖 GEMINI: Audio faylni yuklab olishda xatolik yuz berdi.`;
    }

    if (!audio || !audio.base64) {
        return `🤖 GEMINI: Audio fayl yaroqsiz yoki topilmadi.`;
    }

    // 6) prompt
    const prompt = buildClosedDiagnosisPrompt({
        lead,
        reason,
        now,
        tz: TZ,
        policy: { minAgeInclusive: MIN_AGE_INCLUSIVE },
        history: ctx.history,
        meta: { audioStart: ctx.audioStart, closedAt: ctx.closedAt, from: ctx.from, to: ctx.to },
    });

    // 7) API chaqiruv (Edge-case xatoliklarni ushlab qolish bilan)
    let geminiText;
    try {
        geminiText = await geminiGenerateContent({
            apiKey: GEMINI_API_KEY,
            model: GEMINI_MODEL,
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: audio.mimeType, data: audio.base64 } },
                    ],
                },
            ],
            generationConfig: { temperature: 0.2, maxOutputTokens: 280 },
        });
    } catch (err) {
        console.error(`[Gemini API Error] Lead: ${leadId}`, err.message);
        return `🤖 GEMINI: AI analiz jarayonida xatolik yuz berdi.`;
    }

    const finalText = (geminiText || '').trim() || 'Analiz qaytmadi.';

    // 8) cache yozish
    await LeadModel.updateOne(
        { _id: leadId },
        { $set: { closedGeminiAt: new Date(), closedGeminiUuid: lastUuid, closedGeminiText: finalText } }
    );

    return `🤖 <b>GEMINI:</b> \n${escapeHtml(finalText)}`;
}

module.exports = {
    getGeminiClosedAnalysisLine,
};