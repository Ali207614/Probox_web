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

    // x-www-form-urlencoded body'ni qo'lda quramiz (URLSearchParams probel'ni `+`
    // qiladi, lekin OnlinePBX ba'zan faqat `%20` ni probel deb tushunadi).
    const buildBody = (paramsObj) => {
        const parts = [];
        Object.entries(paramsObj || {}).forEach(([k, v]) => {
            if (v === undefined || v === null || v === '') return;
            const key = encodeURIComponent(k);
            if (Array.isArray(v)) {
                v.forEach((item) => {
                    if (item !== undefined && item !== null && item !== '') {
                        parts.push(`${key}=${encodeURIComponent(String(item))}`);
                    }
                });
            } else {
                parts.push(`${key}=${encodeURIComponent(String(v))}`);
            }
        });
        return parts.join('&');
    };

    const doPost = (path, paramsObj) => {
        const body = buildBody(paramsObj);
        return api.post(path, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }).then((res) => ({ ...res, __sentBody: body }));
    };

    const isInternalError = (d) =>
        d && (d.status === '0' || d.status === 0) && d.errorCode === 'INTERNAL';
    const isAuthError = (d) => d && d.isNotAuth === true && !isInternalError(d);

    const INTERNAL_RETRY_DELAYS_MS = [2000, 4000];

    const previewStr = (v, max = 500) => {
        let s;
        try { s = typeof v === 'string' ? v : JSON.stringify(v); }
        catch { s = String(v); }
        return s && s.length > max ? s.slice(0, max) + '...' : s;
    };

    const postForm = async (path, paramsObj) => {
        try {
            const first = await doPost(path, paramsObj);
            let data = first.data;
            let sentBody = first.__sentBody;

            // 1) Haqiqiy auth failure: PBX HTTP 200 qaytaradi, isNotAuth:true, INTERNAL emas
            if (isAuthError(data)) {
                console.warn(`[OnlinePBX] body-level auth failure on ${path}, re-login & retry`);
                token = { keyId: null, key: null };
                try {
                    await login();
                } catch (loginErr) {
                    throw new Error(`PBX auth olishda xatolik: ${loginErr.message}`);
                }
                const retry = await doPost(path, paramsObj);
                data = retry.data;

                if (isAuthError(data)) {
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

    // OnlinePBX /mongo_history/search.json dokumentatsiyasida sort_by/sort_order yo'q
    // va multi-value trunk_names qo'llab-quvvatlanmaydi. Shuning uchun:
    //   1) undocumented param'larni stripped qilamiz
    //   2) bir nechta trunk berilsa — har biri uchun alohida so'rov yuborib,
    //      natijalarni uuid bo'yicha dedup qilib, start_stamp asc bo'yicha sort qilamiz
    async function searchCalls(params) {
        const { trunk_names, sort_by, sort_order, ...rest } = params || {};
        const trunks = (
            Array.isArray(trunk_names)
                ? trunk_names
                : (trunk_names ? String(trunk_names).split(/[\s,]+/) : [])
        ).map((s) => String(s).trim()).filter(Boolean);

        if (trunks.length <= 1) {
            const p = trunks.length === 1 ? { ...rest, trunk_names: trunks[0] } : rest;
            return postForm('/mongo_history/search.json', p);
        }

        const seen = new Set();
        const merged = [];
        for (const trunk of trunks) {
            const res = await postForm('/mongo_history/search.json', { ...rest, trunk_names: trunk });
            const calls = Array.isArray(res?.data) ? res.data : [];
            for (const c of calls) {
                const uuid = c?.uuid ? String(c.uuid) : null;
                if (!uuid || seen.has(uuid)) continue;
                seen.add(uuid);
                merged.push(c);
            }
        }
        merged.sort((a, b) => Number(a?.start_stamp || 0) - Number(b?.start_stamp || 0));
        return { status: '1', data: merged };
    }

    return {
        login,
        searchCalls,
        getDownloadUrl(uuid) {
            return postForm('/mongo_history/search.json', { uuid, download: '1' });
        },
    };
}

module.exports = { createOnlinePbx };
