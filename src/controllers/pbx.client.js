// pbx.client.js
const axios = require('axios');

function createOnlinePbx({ domain, authKey }) {
    const baseURL = `https://api.onlinepbx.ru/${domain}`;

    const api = axios.create({
        baseURL,
        timeout: 30000,
        headers: { Accept: 'application/json' },
    });

    // in-memory token cache (xohlasangiz keyin Redis qilasiz)
    let token = { keyId: null, key: null };

    async function login() {
        const body = new URLSearchParams({ auth_key: authKey });

        const { data } = await axios.post(`${baseURL}/auth.json`, body, {
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000,
        });

        // ✅ siz bergan response format:
        // { status:"1", data:{ key, key_id, new:1 } }
        const keyId = data?.data?.key_id;
        const key = data?.data?.key;

        if (!keyId || !key) {
            throw new Error('OnlinePBX auth failed: data.data.key_id/key not found');
        }

        token = { keyId, key };
        return token;
    }

    async function getAuthHeader() {
        if (!token.keyId || !token.key) await login();
        return `${token.keyId}:${token.key}`;
    }

    // Har request oldidan tokenni qo'yish
    api.interceptors.request.use(async (config) => {
        const hdr = await getAuthHeader();
        config.headers = config.headers || {};
        config.headers['x-pbx-authentication'] = hdr;
        return config;
    });

    // Token yaroqsiz bo'lsa: re-login + retry (1 marta)
    api.interceptors.response.use(
        (res) => res,
        async (err) => {
            const status = err?.response?.status;
            const msg = String(err?.response?.data?.message || '').toLowerCase();

            const looksAuthIssue =
                status === 401 ||
                status === 403 ||
                msg.includes('auth') ||
                msg.includes('key');

            const cfg = err.config || {};
            if (looksAuthIssue && !cfg.__pbxRetried) {
                cfg.__pbxRetried = true;
                token = { keyId: null, key: null };
                await login();
                return api(cfg);
            }

            throw err;
        }
    );

    const postForm = async (path, paramsObj) => {
        const body = new URLSearchParams();
        Object.entries(paramsObj || {}).forEach(([k, v]) => {
            if (v === undefined || v === null || v === '') return;
            body.append(k, String(v));
        });

        const { data } = await api.post(path, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        return data;
    };

    return {
        login,
        searchCalls(params) {
            return postForm('/mongo_history/search.json', params);
        },
        getDownloadUrl(uuid) {
            return postForm('/mongo_history/search.json', { uuid, download: '1' });
        },
    };
}

module.exports = { createOnlinePbx };
