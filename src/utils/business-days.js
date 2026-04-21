const moment = require('moment-timezone');

const TZ = 'Asia/Tashkent';
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 22;

function addWorkingHours(from, hours) {
    let m = moment.tz(from, TZ);

    if (m.hour() < WORK_START_HOUR) {
        m.hour(WORK_START_HOUR).minute(0).second(0).millisecond(0);
    } else if (m.hour() >= WORK_END_HOUR) {
        m.add(1, 'day').hour(WORK_START_HOUR).minute(0).second(0).millisecond(0);
    }

    let remainingMs = Math.round(hours * 3600 * 1000);

    while (remainingMs > 0) {
        const endOfDay = m.clone().hour(WORK_END_HOUR).minute(0).second(0).millisecond(0);
        const msUntilEndOfDay = endOfDay.diff(m);

        if (remainingMs <= msUntilEndOfDay) {
            m.add(remainingMs, 'ms');
            remainingMs = 0;
        } else {
            remainingMs -= msUntilEndOfDay;
            m = m.add(1, 'day').hour(WORK_START_HOUR).minute(0).second(0).millisecond(0);
        }
    }

    return m.toDate();
}

module.exports = { addWorkingHours, TZ, WORK_START_HOUR, WORK_END_HOUR };
