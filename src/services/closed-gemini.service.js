'use strict';

const LeadModel = require('../models/lead-model'); // pathni moslang
const { geminiGenerateContent } = require('../integrations/gemini/gemini.client');
const { buildClosedDiagnosisPrompt } = require('../integrations/gemini/gemini.prompts');
const { getLastTalkedCallUuidForLead } = require('../integrations/pbx/pbx-last-talked.util');
const { downloadRecordingAsBase64 } = require('../integrations/pbx/pbx-recording.util');
const { escapeHtml } = require('../utils/text.util');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MAX_AUDIO_MB = Number(process.env.GEMINI_MAX_AUDIO_MB || 8);

// Cache TTL (masalan 7 kun) — xohlasangiz o'zgartiring
const GEMINI_CACHE_TTL_MS = Number(process.env.GEMINI_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);

/**
 * lead uchun gemini analiz line qaytaradi:
 * - cache bo'lsa cache
 * - bo'lmasa: last talked uuid topadi -> audio -> gemini
 */
async function getGeminiClosedAnalysisLine({ pbxClient, trunkName, leadId, reason }) {
    const lead = await LeadModel.findById(leadId)
        .select('clientPhone time newTime clientName n closedGeminiAt closedGeminiUuid closedGeminiText')
        .lean();

    if (!lead) return '🤖 GEMINI: lead topilmadi';

    // 1) cache tekshirish
    const cachedAt = lead.closedGeminiAt ? new Date(lead.closedGeminiAt).getTime() : 0;
    const cachedOk = lead.closedGeminiText && cachedAt && (Date.now() - cachedAt) < GEMINI_CACHE_TTL_MS;

    if (cachedOk) {
        return `🤖 <b>GEMINI:</b> ${escapeHtml(lead.closedGeminiText)}`;
    }

    // 2) last talked uuid topish
    const lastUuid = await getLastTalkedCallUuidForLead({
        pbxClient,
        trunkName,
        lead,
    });

    if (!lastUuid) {
        const text = 'audio topilmadi (talk_time > 0 yo‘q)';
        await LeadModel.updateOne(
            { _id: leadId },
            { $set: { closedGeminiAt: new Date(), closedGeminiUuid: null, closedGeminiText: text } }
        );
        return `🤖 GEMINI: ${escapeHtml(text)}`;
    }

    // 3) agar oldin shu uuid bilan analiz bo'lgan bo'lsa, qayta chaqirmaymiz
    if (lead.closedGeminiUuid && String(lead.closedGeminiUuid) === String(lastUuid) && lead.closedGeminiText) {
        return `🤖 <b>GEMINI:</b> ${escapeHtml(lead.closedGeminiText)}`;
    }

    // 4) audio yuklab olish
    const audio = await downloadRecordingAsBase64({
        pbxClient,
        uuid: lastUuid,
        maxMb: GEMINI_MAX_AUDIO_MB,
    });

    // 5) gemini prompt + request
    const prompt = buildClosedDiagnosisPrompt({ lead, reason });

    const geminiText = await geminiGenerateContent({
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
        generationConfig: { temperature: 0.2, maxOutputTokens: 220 },
    });

    const finalText = (geminiText || '').trim() || 'Analiz qaytmadi.';

    // 6) cache yozish
    await LeadModel.updateOne(
        { _id: leadId },
        { $set: { closedGeminiAt: new Date(), closedGeminiUuid: lastUuid, closedGeminiText: finalText } }
    );

    return `🤖 <b>GEMINI:</b> ${escapeHtml(finalText)}`;
}

module.exports = {
    getGeminiClosedAnalysisLine,
};