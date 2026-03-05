'use strict';

function escapeHtml(s = '') {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function digitsOnly(v = '') {
    return String(v ?? '').replace(/\D/g, '');
}

module.exports = {
    escapeHtml,
    digitsOnly,
};