function parseUzDateTime(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v !== 'string') return null;

    // "17.06.2026 00:00" yoki "17.06.2026"
    const m = v.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
    if (!m) return null;

    const dd = Number(m[1]);
    const MM = Number(m[2]);
    const yyyy = Number(m[3]);
    const hh = m[4] != null ? Number(m[4]) : 0;
    const mm = m[5] != null ? Number(m[5]) : 0;

    // Basic range checks
    if (MM < 1 || MM > 12) return null;
    if (dd < 1 || dd > 31) return null;
    if (hh < 0 || hh > 23) return null;
    if (mm < 0 || mm > 59) return null;

    // Local time Date
    const d = new Date(yyyy, MM - 1, dd, hh, mm, 0, 0);

    // Validate that JS didn't roll over (e.g. 31.02 becomes 03.03)
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
        case 'String': return typeof value === 'string';
        case 'Number': return typeof value === 'number' && !isNaN(value);
        case 'Boolean': return typeof value === 'boolean';
        case 'Date': {
            // Date bo'lsa ham, string bo'lsa ham qabul qilamiz (parse bo'lsa)
            if (value instanceof Date) return !isNaN(value.getTime());
            if (typeof value === 'string') return parseUzDateTime(value) !== null;
            return false;
        }
        default: return true;
    }
}

exports.validateFields = (updateData, schema, allowedFields) => {
    const errors = [];
    const validData = {};

    for (const field of allowedFields) {
        if (updateData[field] !== undefined) {
            const pathType = schema.path(field)?.instance;

            if (!isValidType(updateData[field], pathType)) {
                errors.push({
                    field,
                    expected: pathType,
                    received: typeof updateData[field],
                });
                continue;
            }

            // Date bo'lsa: stringni Date ga aylantirib qo'yamiz
            if (pathType === 'Date' && typeof updateData[field] === 'string') {
                validData[field] = parseUzDateTime(updateData[field]);
            } else {
                validData[field] = updateData[field];
            }
        }
    }

    return { validData, errors };
};
