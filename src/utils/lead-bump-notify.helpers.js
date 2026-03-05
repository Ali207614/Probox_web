'use strict';

const { escapeHtml } = require('../utils/text.util');
const { TZ } = require('../constants/lead-bump-notify.constants');

const WORK_HOUR_START = Number(process.env.WORK_HOUR_START || 9);
const WORK_HOUR_END = Number(process.env.WORK_HOUR_END || 21);

const LEAD_LINK_BASE = process.env.LEAD_LINK_BASE || 'https://yourdomain.com/leads';

const QA_GROUP_CHAT_ID = process.env.QA_GROUP_CHAT_ID || null;
const QA_MENTION_USER_ID = process.env.QA_MENTION_USER_ID || null;
const QA_MENTION_NAME = process.env.QA_MENTION_NAME || 'Aloqa markazi';

function isWithinWorkingHours(date) {
    const hour = new Date(date.toLocaleString('en-US', { timeZone: TZ })).getHours();
    return hour >= WORK_HOUR_START && hour < WORK_HOUR_END;
}

function buildLeadLink(leadId) {
    return `${LEAD_LINK_BASE}/${leadId}`;
}

function buildMentionTag() {
    if (QA_MENTION_USER_ID) {
        return `<a href="tg://user?id=${QA_MENTION_USER_ID}">${escapeHtml(QA_MENTION_NAME)}</a>`;
    }
    return escapeHtml(QA_MENTION_NAME);
}

module.exports = {
    QA_GROUP_CHAT_ID,
    escapeHtml,
    isWithinWorkingHours,
    buildLeadLink,
    buildMentionTag,
    TZ,
};