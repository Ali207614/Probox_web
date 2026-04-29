'use strict';

const Axios = require('axios');
const https = require('https');
const { get } = require('lodash');

const b1SL = require('../controllers/b1SL');
const { getSession } = require('../helpers');
const { api } = require('../config');

function buildAxios() {
    const sess = getSession() || {};
    return Axios.create({
        baseURL: `${api}`,
        timeout: 30000,
        headers: {
            Cookie:
                get(sess, 'Cookie[0]', '') + get(sess, 'Cookie[1]', ''),
            SessionId: get(sess, 'SessionId', ''),
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
}

class SlError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status || 500;
    }
}

async function slRequest(method, url, body, config = {}, retried = false) {
    try {
        const ax = buildAxios();
        const res = await ax.request({ method, url, data: body, ...config });
        return res.data;
    } catch (err) {
        const status = get(err, 'response.status');

        if (status === 401 && !retried) {
            const token = await b1SL.auth();
            if (token?.status) return slRequest(method, url, body, config, true);
            throw new SlError(token?.message || 'Service Layer auth failed', 401);
        }

        const message = get(
            err,
            'response.data.error.message.value',
            err.message || 'Service Layer error'
        );
        throw new SlError(message, status || 500);
    }
}

module.exports = {
    slGet: (url, config) => slRequest('get', url, undefined, config),
    slPost: (url, body, config) => slRequest('post', url, body, config),
    slPatch: (url, body, config) =>
        slRequest('patch', url, body, {
            headers: { 'B1S-ReplaceCollectionsOnPatch': 'true' },
            ...config,
        }),
    SlError,
};
