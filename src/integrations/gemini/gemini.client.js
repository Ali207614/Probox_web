'use strict';

const axios = require('axios');

async function geminiGenerateContent({ apiKey, model, contents, generationConfig }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY missing');

    const m = model || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

    const body = {
        contents,
        generationConfig: generationConfig || {
            temperature: 0.2,
            maxOutputTokens: 220,
        },
    };

    const resp = await axios.post(url, body, {
        timeout: 60000,
        validateStatus: (s) => s >= 200 && s < 500,
    });

    if (resp.status >= 400) {
        const msg = resp.data?.error?.message || `Gemini error status=${resp.status}`;
        throw new Error(msg);
    }

    const text =
        resp.data?.candidates?.[0]?.content?.parts
            ?.map((p) => p?.text)
            .filter(Boolean)
            .join('\n')
            .trim() || '';

    return text || '';
}

module.exports = {
    geminiGenerateContent,
};