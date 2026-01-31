function normalizeSpaces(s) {
    return String(s).replace(/\u00A0/g, ' ').trim();
}

function parseUzDateTime(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v !== 'string') return null;

    const s = normalizeSpaces(v);

    // 1) DD.MM.YYYY [HH:mm]
    let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
    let dd, MM, yyyy, hh, mm;

    if (m) {
        dd = Number(m[1]);
        MM = Number(m[2]);
        yyyy = Number(m[3]);
        hh = m[4] != null ? Number(m[4]) : 0;
        mm = m[5] != null ? Number(m[5]) : 0;
    } else {
        // 2) YYYY.MM.DD [HH:mm]
        m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2}))?$/);
        if (!m) return null;

        yyyy = Number(m[1]);
        MM = Number(m[2]);
        dd = Number(m[3]);
        hh = m[4] != null ? Number(m[4]) : 0;
        mm = m[5] != null ? Number(m[5]) : 0;
    }

    // Range checks
    if (MM < 1 || MM > 12) return null;
    if (dd < 1 || dd > 31) return null;
    if (hh < 0 || hh > 23) return null;
    if (mm < 0 || mm > 59) return null;

    const d = new Date(yyyy, MM - 1, dd, hh, mm, 0, 0);

    // rollover check
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
