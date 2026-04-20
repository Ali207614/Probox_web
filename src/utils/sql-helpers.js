'use strict';

const VALID_STATUSES = new Set(['paid', 'unpaid', 'partial']);

function escapeString(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/'/g, "''");
}

function safeInt(value, fieldName = 'value') {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error(`Invalid integer for ${fieldName}: ${value}`);
    }
    return n;
}

/**
 * "YYYY-MM-DD" yoki "YYYY.MM.DD" → "YYYY-MM-DD"
 */
function safeDate(value, fieldName = 'date') {
    if (typeof value !== 'string') throw new Error(`Invalid ${fieldName}`);
    const m = value.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/);
    if (!m) throw new Error(`Invalid ${fieldName} format: ${value}`);
    return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * (T0.DocEntry = X AND T0.InstlmntID = Y) OR ... ko'rinishidagi string.
 * list bo'sh bo'lsa '' qaytaradi.
 */
function buildInvoiceKeyList(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return list
        .map(item => {
            const de = safeInt(item.DocEntry, 'DocEntry');
            const id = safeInt(item.InstlmntID, 'InstlmntID');
            return `(T0."DocEntry" = ${de} AND T0."InstlmntID" = ${id})`;
        })
        .join(' OR ');
}

function filterPaymentStatuses(raw) {
    if (!raw) return [];
    return String(raw)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => VALID_STATUSES.has(s));
}

module.exports = {
    escapeString,
    safeInt,
    safeDate,
    buildInvoiceKeyList,
    filterPaymentStatuses,
};