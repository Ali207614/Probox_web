// controllers/helpers/invoice-helpers.js
'use strict';

const moment = require('moment');
const DATE_FMT = 'YYYY.MM.DD';

const INVOICE_PROJECTION = {
    phoneConfiscated: 1, DocEntry: 1, InstlmntID: 1, SlpCode: 1,
    images: 1, newDueDate: 1, CardCode: 1, partial: 1, InsTotal: 1,
};

function normalizeDateRange(startDate, endDate) {
    const now = moment();
    const sd = moment(startDate, DATE_FMT, true).isValid()
        ? startDate : now.clone().startOf('month').format(DATE_FMT);
    const ed = moment(endDate, DATE_FMT, true).isValid()
        ? endDate : now.clone().endOf('month').format(DATE_FMT);
    return {
        startDate: sd,
        endDate: ed,
        startMoment: moment(sd, DATE_FMT).startOf('day').toDate(),
        endMoment: moment(ed, DATE_FMT).endOf('day').toDate(),
    };
}

function parseSlpCodes(raw) {
    if (!raw) return null;
    const arr = String(raw).split(',').map(Number).filter(Number.isInteger);
    return arr.length ? arr : null;
}

function applyPhoneConfiscatedFilter(filter, phoneConfiscated) {
    if (phoneConfiscated === 'true') {
        filter.phoneConfiscated = true;
    } else if (phoneConfiscated === 'false') {
        filter.$or = [
            { phoneConfiscated: false },
            { phoneConfiscated: { $exists: false } },
        ];
    }
}

function groupComments(comments) {
    const map = {};
    for (const c of comments) {
        const key = `${c.DocEntry}_${c.InstlmntID}`;
        (map[key] ||= []).push(c);
    }
    return map;
}

function buildUserLocationMap(users) {
    const m = new Map();
    for (const u of users) {
        if (u.CardCode) m.set(u.CardCode, { lat: u.lat ?? null, long: u.long ?? null });
    }
    return m;
}

module.exports = {
    INVOICE_PROJECTION,
    normalizeDateRange,
    parseSlpCodes,
    applyPhoneConfiscatedFilter,
    groupComments,
    buildUserLocationMap,
};