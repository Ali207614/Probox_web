// pbx.client.js
const axios = require('axios');

function createOnlinePbx({ domain, authKey, apiHost = 'https://api2.onlinepbx.ru' }) {
    const baseURL = `${apiHost}/${domain}`;
    console.log(`OnlinePBX API baseURL: ${baseURL}`);
    const api = axios.create({
        baseURL,
        timeout: 30000,
        headers: { Accept: 'application/json' },
    });

    let token = { keyId: null, key: null };

    async function login() {
        const body = new URLSearchParams({ auth_key: authKey });

        const resp = await axios.post(`${baseURL}/auth.json`, body, {
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000,
        });

        let data = resp.data;

        // ba'zan string kelishi mumkin
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { /* ignore */ }
        }

        const keyId =
            data?.data?.key_id ||
            data?.key_id ||
            data?.data?.keyId ||
            data?.keyId;

        const key =
            data?.data?.key ||
            data?.key ||
            data?.data?.token ||
            data?.token;

        if (!keyId || !key) {
            // debug uchun response'ni ham ko'rsatamiz
            throw new Error(
                `OnlinePBX auth failed: key_id/key not found. Response: ${JSON.stringify(data)}`
            );
        }

        token = { keyId, key };
        return token;
    }

    async function getAuthHeader() {
        if (!token.keyId || !token.key) await login();
        return `${token.keyId}:${token.key}`;
    }

    api.interceptors.request.use(async (config) => {
        const hdr = await getAuthHeader();
        config.headers = config.headers || {};
        config.headers['x-pbx-authentication'] = hdr;
        return config;
    });

    api.interceptors.response.use(
        (res) => res,
        async (err) => {
            const status = err?.response?.status;
            const msg = String(err?.response?.data?.message || '').toLowerCase();

            const looksAuthIssue =
                status === 401 || status === 403 || msg.includes('auth') || msg.includes('key');

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
