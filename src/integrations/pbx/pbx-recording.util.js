'use strict';

const axios = require('axios');

function pickOnlineUrl(dl) {
    return typeof dl === 'string'
        ? dl
        : typeof dl?.data === 'string'
            ? dl.data
            : dl?.data?.url || dl?.url || null;
}

async function downloadRecordingAsBase64({ pbxClient, uuid, maxMb = 8 }) {
    if (!pbxClient) throw new Error('pbxClient is required');
    if (!uuid) throw new Error('uuid is required');

    const dl = await pbxClient.getDownloadUrl(uuid);
    const onlineUrl = pickOnlineUrl(dl);
    if (!onlineUrl) throw new Error('Recording url not found');

    const maxBytes = Number(maxMb) * 1024 * 1024;

    const r = await axios.get(onlineUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { Range: `bytes=0-${maxBytes - 1}` },
        validateStatus: (s) => s >= 200 && s < 500,
    });

    if (r.status >= 400) {
        throw new Error(`Recording download failed: status=${r.status}`);
    }

    const contentType = r.headers['content-type'] || 'audio/mpeg';
    const buf = Buffer.from(r.data);

    return {
        mimeType: contentType,
        base64: buf.toString('base64'),
        sizeBytes: buf.length,
    };
}

module.exports = {
    downloadRecordingAsBase64,
};