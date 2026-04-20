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

    // api2.onlinepbx.ru imzolashni talab qilmaydi:
    //   /auth.json qaytargan {key_id, key} ni shunchaki header'ga qo'yamiz.
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

    const doPost = (path, paramsObj) => {
        const body = buildBody(paramsObj);
        return api.post(path, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }).then((res) => ({ ...res, __sentBody: body }));
    };

    const isInternalError = (d) =>
        d && (d.status === '0' || d.status === 0) && d.errorCode === 'INTERNAL';
    // isNotAuth:true — errorCode INTERNAL bo'lsa ham auth muammosi deb qaraymiz
    // (OnlinePBX token TTL tugaganda ko'pincha shu kombinatsiyani qaytaradi).
    const needsReauth = (d) => d && d.isNotAuth === true;

    // OnlinePBX server beqaror: ~20% so'rov INTERNAL qaytarishi mumkin.
    // Shuning uchun 4 qayta urinish (jami 5 ta). Eksponensial backoff.
    const INTERNAL_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

    const previewStr = (v, max = 500) => {
        let s;
        try {
            if (v instanceof URLSearchParams) s = v.toString();
            else if (typeof v === 'string') s = v;
            else s = JSON.stringify(v);
        } catch { s = String(v); }
        return s && s.length > max ? s.slice(0, max) + '...' : s;
    };

    const postForm = async (path, paramsObj) => {
        try {
            const first = await doPost(path, paramsObj);
            let data = first.data;
            let sentBody = first.__sentBody;

            // 1) isNotAuth:true — errorCode qanday bo'lishidan qat'iy nazar,
            // token TTL tugagan bo'lishi mumkin. Re-login qilib bir marta retry.
            if (needsReauth(data)) {
                console.warn(
                    `[OnlinePBX] isNotAuth on ${path} (errorCode=${data.errorCode || 'N/A'}), re-login & retry`
                );
                token = { keyId: null, key: null };
                try {
                    await login();
                } catch (loginErr) {
                    throw new Error(`PBX auth olishda xatolik: ${loginErr.message}`);
                }
                const retry = await doPost(path, paramsObj);
                data = retry.data;
                sentBody = retry.__sentBody;

                // Re-login'dan keyin ham isNotAuth va INTERNAL emas — haqiqiy auth rad etilishi
                if (needsReauth(data) && !isInternalError(data)) {
                    const comment = data.comment || 'no comment';
                    const code = data.errorCode || 'N/A';
                    throw new Error(
                        `PBX auth olishda xatolik: yangi auth olindi lekin server avtorizatsiyani qabul qilmadi (${comment}, code=${code})`
                    );
                }
            }

            // 2) PBX server ichki xatosi (errorCode=INTERNAL): backoff bilan qayta urinish
            if (isInternalError(data)) {
                console.warn(
                    `[OnlinePBX] INTERNAL error on ${path}\n  sent: ${previewStr(sentBody)}\n  resp: ${previewStr(data)}`
                );
                for (let i = 0; i < INTERNAL_RETRY_DELAYS_MS.length; i++) {
                    const delay = INTERNAL_RETRY_DELAYS_MS[i];
                    console.warn(
                        `[OnlinePBX] INTERNAL error on ${path}, retry ${i + 1}/${INTERNAL_RETRY_DELAYS_MS.length} in ${delay}ms`
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    const retry = await doPost(path, paramsObj);
                    data = retry.data;
                    sentBody = retry.__sentBody;
                    if (!isInternalError(data)) break;
                }

                if (isInternalError(data)) {
                    const attempts = INTERNAL_RETRY_DELAYS_MS.length + 1;
                    const comment = data.comment || 'no comment';
                    throw new Error(
                        `PBX server ichki xatoligi (${attempts} marta urinildi): ${comment} | sent=${previewStr(sentBody, 300)} | resp=${previewStr(data, 300)}`
                    );
                }
            }

            return data;
        } catch (e) {
            console.error(`[OnlinePBX] API Error on ${path}:`, e?.response?.data || e.message);
            throw e;
        }
    };

    // Array'larni to'g'ri separator bilan birlashtiradi:
    // - trunk_names: probel (OnlinePBX shu formatni kutadi)
    // - phone_numbers / sub_phone_numbers / uuid_array: vergul (dokumentatsiya bo'yicha)
    function normalizeParams(params) {
        const out = { ...(params || {}) };
        const joinWithSpace = ['trunk_names'];
        const joinWithComma = ['phone_numbers', 'sub_phone_numbers', 'uuid_array'];

        for (const k of joinWithSpace) {
            if (Array.isArray(out[k])) {
                out[k] = out[k].map((s) => String(s).trim()).filter(Boolean).join(' ');
            }
        }
        for (const k of joinWithComma) {
            if (Array.isArray(out[k])) {
                out[k] = out[k].map((s) => String(s).trim()).filter(Boolean).join(',');
            }
        }
        return out;
    }

    return {
        login,
        searchCalls(params) {
            return postForm('/mongo_history/search.json', normalizeParams(params));
        },
        getDownloadUrl(uuid) {
            // PBX `uuid_array` ni kutadi, `uuid` emas — aks holda INTERNAL qaytaradi
            return postForm('/mongo_history/search.json', { uuid_array: uuid, download: '1' });
        },
    };
}

module.exports = { createOnlinePbx };
