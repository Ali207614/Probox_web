'use strict';

const TZ = 'Asia/Tashkent';

const CRON_INTERVAL = '*/2 * * * *';

const TARGET_STATUSES = ['FollowUp', 'Considering', 'WillVisitStore', 'WillSendPassport'];

const NO_PURCHASE_STATUS = 'NoPurchase';
const CLOSED_STATUS = 'Closed';

const STATUS_LABELS = {
    FollowUp: 'Qayta aloqa',
    Considering: "O'ylab ko'radi",
    WillVisitStore: "Do'konga boradi",
    WillSendPassport: 'Passport yuboradi',
    NoPurchase: "Xarid bo'lmadi",
    Closed: 'Yopilgan',
};

module.exports = {
    TZ,
    CRON_INTERVAL,
    TARGET_STATUSES,
    NO_PURCHASE_STATUS,
    CLOSED_STATUS,
    STATUS_LABELS,
};