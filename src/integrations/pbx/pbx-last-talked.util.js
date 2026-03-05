'use strict';

const { digitsOnly } = require('../../utils/text.util');

function normalizePbxCallsArray(res) {
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res)) return res;
    return [];
}

function toUnixSec(value) {
    if (!value) return null;
    const d = new Date(value);
    const t = Math.floor(d.getTime() / 1000);
    return Number.isFinite(t) ? t : null;
}

function buildLeadPbxRange(lead) {
    const from = toUnixSec(lead?.time);
    if (!from) return null;

    const newTime = toUnixSec(lead?.newTime);

    if (newTime && newTime >= from) {
        return { start_stamp_from: from, start_stamp_to: newTime };
    }

    // fallback: +1 kun
    return { start_stamp_from: from, start_stamp_to: from + 24 * 60 * 60 };
}

function buildLeadPhoneVariants(raw) {
    const d = digitsOnly(raw);
    if (!d) return { full: null, local: null };

    if (d.startsWith('998') && d.length >= 12) return { full: d.slice(0, 12), local: d.slice(3, 12) };
    if (/^\d{9}$/.test(d)) return { full: `998${d}`, local: d };
    return { full: d, local: d.length >= 9 ? d.slice(-9) : d };
}

/**
 * Lead bo'yicha gaplashilgan (user_talk_time_from:1) call'lar ichidan eng oxirgisini topadi.
 */
async function getLastTalkedCallUuidForLead({ pbxClient, trunkName, lead }) {
    if (!pbxClient) throw new Error('pbxClient is required');
    if (!lead?.clientPhone) return null;

    const phones = buildLeadPhoneVariants(lead.clientPhone);
    const local9 = phones.local || digitsOnly(lead.clientPhone);
    if (!local9) return null;

    const range = buildLeadPbxRange(lead);
    if (!range) return null;

    const MAX_RANGE_SEC = 7 * 24 * 60 * 60;

    let cursorFrom = range.start_stamp_from;
    const finalTo = range.start_stamp_to;

    let lastCall = null;

    while (cursorFrom <= finalTo) {
        const chunkTo = Math.min(cursorFrom + MAX_RANGE_SEC - 1, finalTo);

        const res = await pbxClient.searchCalls({
            sub_phone_numbers: local9,
            start_stamp_from: cursorFrom,
            start_stamp_to: chunkTo,
            user_talk_time_from: 1,
            sort_by: 'start_stamp',
            sort_order: 'asc',
            trunk_names: trunkName,
        });

        const calls = normalizePbxCallsArray(res);
        for (const c of calls) {
            if (!c?.uuid) continue;
            lastCall = c; // asc bo'lgani uchun oxirgi overwrite bo'ladi
        }

        cursorFrom = chunkTo + 1;
    }

    return lastCall?.uuid ? String(lastCall.uuid) : null;
}

module.exports = {
    getLastTalkedCallUuidForLead,
    buildLeadPhoneVariants,
    buildLeadPbxRange,
};