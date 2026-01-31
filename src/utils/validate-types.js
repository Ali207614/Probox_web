function isValidType(value, expectedType) {
    if (value === null || value === undefined) return true;
    switch (expectedType) {
        case 'String': return typeof value === 'string';
        case 'Number': return typeof value === 'number' && !isNaN(value);
        case 'Boolean': return typeof value === 'boolean';
        case 'Date': return !isNaN(new Date(value).getTime());
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

            if (pathType === 'Date' && typeof updateData[field] === 'string') {
                validData[field] = new Date(updateData[field]);
            } else {
                validData[field] = updateData[field];
            }
        }
    }

    return { validData, errors };
};
