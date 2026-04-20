// pbx.client.js
const axios = require('axios');

function createOnlinePbx({ domain, authKey, apiHost = 'https://api2.onlinepbx.ru' }) {
    const baseURL = `${apiHost}/${domain}`;

    const api = axios.create({
        baseURL,
        timeout: 30000,
        headers: { Accept: 'application/json' },
    });

    let token = { keyId: null, key: null };

    async function login() {
        const body = new URLSearchParams({ auth_key: authKey });

        let resp;
        try {
            resp = await axios.post(`${baseURL}/auth.json`, body, {
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: 30000,
            });
        } catch (e) {
            const detail =
                e?.response?.data?.comment ||
                e?.response?.statusText ||
                e.message;
            throw new Error(`PBX auth olishda xatolik: ${detail}`);
        }

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
            let preview;
            try { preview = JSON.stringify(data); } catch { preview = String(data); }
            if (preview && preview.length > 200) preview = preview.slice(0, 200) + '...';
            throw new Error(`PBX auth olishda xatolik: key_id/key topilmadi (resp=${preview})`);
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
                try {
                    await login();
                } catch (loginErr) {
                    throw new Error(`PBX auth olishda xatolik: ${loginErr.message}`);
                }
                return api(cfg);
            }

            throw err;
        }
    );

    const buildBody = (paramsObj) => {
        const body = new URLSearchParams();
        Object.entries(paramsObj || {}).forEach(([k, v]) => {
            if (v === undefined || v === null || v === '') return;
            if (Array.isArray(v)) {
                v.forEach((item) => {
                    if (item !== undefined && item !== null && item !== '') {
                        body.append(k, String(item));
                    }
                });
            } else {
                body.append(k, String(v));
            }
        });
        return body;
    };

    const postForm = async (path, paramsObj) => {
        try {
            let { data } = await api.post(path, buildBody(paramsObj), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });

            // Body darajasidagi auth failure: PBX HTTP 200 qaytaradi, lekin isNotAuth:true bo'ladi
            if (data && data.isNotAuth === true) {
                console.warn(`[OnlinePBX] body-level auth failure on ${path}, re-login & retry`);
                token = { keyId: null, key: null };
                try {
                    await login();
                } catch (loginErr) {
                    throw new Error(`PBX auth olishda xatolik: ${loginErr.message}`);
                }
                const retry = await api.post(path, buildBody(paramsObj), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                });
                data = retry.data;

                if (data && data.isNotAuth === true) {
                    const comment = data.comment || 'no comment';
                    const code = data.errorCode || 'N/A';
                    throw new Error(
                        `PBX auth olishda xatolik: yangi auth olindi lekin server avtorizatsiyani qabul qilmadi (${comment}, code=${code})`
                    );
                }
            }

            return data;
        } catch (e) {
            console.error(`[OnlinePBX] API Error on ${path}:`, e?.response?.data || e.message);
            throw e;
        }
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
