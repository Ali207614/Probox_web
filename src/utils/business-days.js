const moment = require('moment-timezone');

const TZ = 'Asia/Tashkent';

function isBusinessDay(m) {
    const day = m.day();
    return day !== 0 && day !== 6;
}

function addBusinessDays(from, days) {
    const m = moment.tz(from, TZ);
    let remaining = days;
    while (remaining > 0) {
        m.add(1, 'day');
        if (isBusinessDay(m)) remaining -= 1;
    }
    return m.toDate();
}

module.exports = { addBusinessDays, TZ };
