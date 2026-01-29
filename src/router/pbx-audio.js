const axios = require('axios');
const LeadChat = require('../models/lead-chat-model');

module.exports = (pbxClient) => async (req, res, next) => {
    try {
        const { uuid } = req.params;

        // 1) OnlinePBX'dan download url olish
        const dl = await pbxClient.getDownloadUrl(uuid);

        // dl formatlari: {status:"1", data:"https://..."} yoki boshqa
        const url =
            typeof dl === 'string'
                ? dl
                : (typeof dl?.data === 'string' ? dl.data : dl?.data?.url || dl?.url);

        if (!url) {
            return res.status(404).json({ message: 'Recording url not found' });
        }

        // 2) MP3 ni server orqali stream qilish
        const r = await axios.get(url, { responseType: 'stream', timeout: 60000 });

        res.setHeader('Content-Type', r.headers['content-type'] || 'audio/mpeg');
        res.setHeader('Cache-Control', 'private, max-age=300'); // 5 min cache
        // CORS (agar frontend boshqa domen bo'lsa)
        res.setHeader('Access-Control-Allow-Origin', '*');

        r.data.pipe(res);
    } catch (e) {
        next(e);
    }
};
