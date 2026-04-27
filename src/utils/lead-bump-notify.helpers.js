'use strict';

const { escapeHtml } = require('../utils/text.util');
const { TZ } = require('../constants/lead-bump-notify.constants');

const WORK_HOUR_START = Number(process.env.WORK_HOUR_START || 9);
const WORK_HOUR_END = Number(process.env.WORK_HOUR_END || 21);

const LEAD_LINK_BASE = process.env.LEAD_LINK_BASE || 'https://yourdomain.com/leads';

const QA_GROUP_CHAT_ID = process.env.QA_GROUP_CHAT_ID || null;
const QA_TOPIC_SIFATSIZ = Number(process.env.QA_TOPIC_SIFATSIZ || 6086);
const QA_TOPIC_VAZIFALAR = Number(process.env.QA_TOPIC_VAZIFALAR || 6082);
const QA_TOPIC_BOLIM_RAHBARI = Number(process.env.QA_TOPIC_BOLIM_RAHBARI || 14016);
const QA_MENTION_USER_ID = process.env.QA_MENTION_USER_ID || null;
const QA_MENTION_NAME = process.env.QA_MENTION_NAME || 'Aloqa markazi';

const HEAD_MENTION_USER_ID = process.env.HEAD_MENTION_USER_ID || null;
const HEAD_MENTION_NAME = process.env.HEAD_MENTION_NAME || "Bo'lim boshlig'i";

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

function buildHeadMentionTag() {
    if (HEAD_MENTION_USER_ID) {
        return `<a href="tg://user?id=${HEAD_MENTION_USER_ID}">${escapeHtml(HEAD_MENTION_NAME)}</a>`;
    }
    return escapeHtml(HEAD_MENTION_NAME);
}

module.exports = {
    QA_GROUP_CHAT_ID,
    QA_TOPIC_SIFATSIZ,
    QA_TOPIC_VAZIFALAR,
    QA_TOPIC_BOLIM_RAHBARI,
    escapeHtml,
    isWithinWorkingHours,
    buildLeadLink,
    buildMentionTag,
    buildHeadMentionTag,
    TZ,
};