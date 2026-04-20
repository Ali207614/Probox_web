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
    // Single-flight: ko'p so'rov bir vaqtda login talab qilsa, faqat bitta /auth.json chaqiruv
    let pendingLogin = null;

    function _doLogin() {
        const body = new URLSearchParams({ auth_key: authKey });
        return axios.post(`${baseURL}/auth.json`, body, {
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000,
        }).then((resp) => {
            let data = resp.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { /* ignore */ }
            }
            const keyId = data?.data?.key_id || data?.key_id || data?.data?.keyId || data?.keyId;
            const key = data?.data?.key || data?.key || data?.data?.token || data?.token;
            if (!keyId || !key) {
                let preview;
                try { preview = JSON.stringify(data); } catch { preview = String(data); }
                if (preview && preview.length > 200) preview = preview.slice(0, 200) + '...';
                throw new Error(`PBX auth olishda xatolik: key_id/key topilmadi (resp=${preview})`);
            }
            token = { keyId, key };
            return token;
        }).catch((e) => {
            const detail =
                e?.response?.data?.comment ||
                e?.response?.statusText ||
                e.message;
            throw new Error(`PBX auth olishda xatolik: ${detail}`);
        });
    }

    async function login() {
        if (pendingLogin) return pendingLogin;
        pendingLogin = _doLogin();
        try {
            return await pendingLogin;
        } finally {
            pendingLogin = null;
        }
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
    // Faqat toza auth muammosi: isNotAuth:true va INTERNAL emas.
    // (OnlinePBX ichki xatolarida ham isNotAuth:true qaytaradi — uni auth
    // muammosi deb talqin qilmaymiz, aks holda har INTERNAL'da ortiqcha re-login bo'ladi.)
    const isPureAuthError = (d) =>
        d && d.isNotAuth === true && !isInternalError(d);

    // OnlinePBX server hozir ~50% INTERNAL/tarmoq xatosi qaytaryapti.
    // 7 qayta urinish (jami 8 urinish): 0.5^8 = 0.4% hard fail.
    // Jitter ±30% — bir vaqtda fail bo'lgan ko'p so'rov serverni yanada yuklamasligi uchun.
    const RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 7000, 10000];
    const withJitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

    // Tarmoq xatolari (timeout, ECONNRESET, socket hang up, ...) — response bo'lmaydi
    const isNetworkError = (err) =>
        !!err && !err.response && (
            err.code === 'ECONNRESET' ||
            err.code === 'ECONNABORTED' ||
            err.code === 'ETIMEDOUT' ||
            err.code === 'ENOTFOUND' ||
            err.code === 'EAI_AGAIN' ||
            /timeout|socket hang up|network/i.test(err.message || '')
        );

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
        const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 8 ta jami
        let lastData = null;
        let lastSentBody = null;
        let reauthed = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const resp = await doPost(path, paramsObj);
                lastData = resp.data;
                lastSentBody = resp.__sentBody;

                // Toza auth xatosi — bir martagina re-login + darhol retry (backoffsiz)
                if (isPureAuthError(lastData) && !reauthed) {
                    reauthed = true;
                    console.warn(`[OnlinePBX] pure auth failure on ${path}, re-login & retry`);
                    token = { keyId: null, key: null };
                    await login();
                    continue;
                }

                // Re-login'dan keyin ham toza auth xatosi — fatal
                if (isPureAuthError(lastData)) {
                    throw new Error(
                        `PBX auth rad etildi: ${lastData.comment || 'no comment'} (code=${lastData.errorCode || 'N/A'})`
                    );
                }

                // INTERNAL — retry qilinadi
                if (isInternalError(lastData)) {
                    if (attempt < MAX_ATTEMPTS) {
                        const base = RETRY_DELAYS_MS[attempt - 1];
                        const delay = withJitter(base);
                        console.warn(
                            `[OnlinePBX] INTERNAL on ${path} (urinish ${attempt}/${MAX_ATTEMPTS}), ${delay}ms kutish`
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    // Urinishlar tugadi
                    throw new Error(
                        `PBX server ichki xatoligi (${MAX_ATTEMPTS} urinish): ${lastData.comment || 'no comment'} | sent=${previewStr(lastSentBody, 300)} | resp=${previewStr(lastData, 300)}`
                    );
                }

                // Muvaffaqiyat (yoki boshqa javob)
                return lastData;
            } catch (err) {
                // Tarmoq xatosi — retry qilinadi
                if (isNetworkError(err) && attempt < MAX_ATTEMPTS) {
                    const base = RETRY_DELAYS_MS[attempt - 1];
                    const delay = withJitter(base);
                    console.warn(
                        `[OnlinePBX] tarmoq xatosi on ${path} (urinish ${attempt}/${MAX_ATTEMPTS}): ${err.code || err.message}, ${delay}ms kutish`
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                console.error(`[OnlinePBX] API Error on ${path}:`, err?.response?.data || err.message);
                throw err;
            }
        }

        // Bu yerga kelmasligi kerak, lekin xavfsizlik uchun
        return lastData;
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
