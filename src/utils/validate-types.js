function normalizeSpaces(s) {
    // NBSP (\u00A0) va boshqa whitespace'larni oddiy spacega aylantiramiz
    return String(s).replace(/\u00A0/g, ' ').trim();
}

function parseUzDateTime(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v !== 'string') return null;

    const s = normalizeSpaces(v);

    // 1) "17.06.2026 00:00" (HH:mm majburiy)
    let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
    let hasTime = true;

    // 2) "17.06.2026" (time yo'q bo'lsa 00:00 qilamiz)
    if (!m) {
        m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        hasTime = false;
    }

    if (!m) return null;

    const dd = Number(m[1]);
    const MM = Number(m[2]);
    const yyyy = Number(m[3]);
    const hh = hasTime ? Number(m[4]) : 0;
    const mm = hasTime ? Number(m[5]) : 0;

    // Range checks
    if (MM < 1 || MM > 12) return null;
    if (dd < 1 || dd > 31) return null;
    if (hh < 0 || hh > 23) return null;
    if (mm < 0 || mm > 59) return null;

    // Local time Date
    const d = new Date(yyyy, MM - 1, dd, hh, mm, 0, 0);

    // Rollover check (31.02 -> 03.03 kabi xatolarni ushlash)
    if (
        d.getFullYear() !== yyyy ||
        d.getMonth() !== MM - 1 ||
        d.getDate() !== dd ||
        d.getHours() !== hh ||
        d.getMinutes() !== mm
    ) return null;

    return d;
}

function isValidType(value, expectedType) {
    if (value === null || value === undefined) return true;

    switch (expectedType) {
        case 'String':
            return typeof value === 'string';

        case 'Number':
            return typeof value === 'number' && !isNaN(value);

        case 'Boolean':
            return typeof value === 'boolean';

        case 'Date': {
            if (value instanceof Date) return !isNaN(value.getTime());
            if (typeof value === 'string') return parseUzDateTime(value) !== null;
            return false;
        }

        default:
            // Mixed/undefined bo'lsa ham bu yerda true deyish xavfli.
            // Lekin sizning logikangiz shunaqa bo'lsa qoldiramiz.
            return true;
    }
}

exports.validateFields = (updateData, schema, allowedFields) => {
    const errors = [];
    const validData = {};

    for (const field of allowedFields) {
        if (updateData[field] === undefined) continue;

        const value = updateData[field];

        // Schema type (ba'zan undefined bo'lishi mumkin)
        const path = schema?.path?.(field);
        const pathType = path?.instance;

        // Fallback: agar schema Date deb bermasa ham, value date-string bo'lsa parse qilamiz
        const parsed = (typeof value === 'string') ? parseUzDateTime(value) : null;
        const looksLikeUzDateString = typeof value === 'string' && parsed !== null;

        // 1) Agar schema Date bo'lsa — qat'iy tekshiramiz
        // 2) Agar schema type topilmasa, lekin value date-string bo'lsa — Date qilib yuboramiz
        if (pathType === 'Date' || looksLikeUzDateString) {
            if (value instanceof Date) {
                validData[field] = value;
                continue;
            }

            if (typeof value === 'string') {
                if (!parsed) {
                    errors.push({
                        field,
                        expected: 'Date (DD.MM.YYYY HH:mm)',
                        receivedType: typeof value,
                        receivedValue: value,
                    });
                    continue;
                }
                validData[field] = parsed; // ✅ soat/minut ham saqlanadi
                continue;
            }

            errors.push({
                field,
                expected: 'Date',
                receivedType: typeof value,
                receivedValue: value,
            });
            continue;
        }

        // Normal type check (String/Number/Boolean)
        if (!isValidType(value, pathType)) {
            errors.push({
                field,
                expected: pathType,
                receivedType: typeof value,
                receivedValue: value,
            });
            continue;
        }

        validData[field] = value;
    }

    return { validData, errors };
};
