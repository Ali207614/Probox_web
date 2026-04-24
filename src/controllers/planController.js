const Plan = require('../models/plan-model');
const ApiError = require('../exceptions/api-error');

const FINANCIAL_ROLES = new Set(['CEO', 'Manager']);
const FINANCIAL_FIELDS = new Set(['salesAmount', 'averageCheck']);

const NUMERIC_FIELDS = [
    'lead',
    'qualityLead',
    'scoringSent',
    'scoringApproved',
    'meetingSet',
    'willVisitStore',
    'meetingHappened',
    'visitedStore',
    'contractSigned',
    'salesAmount',
    'averageCheck'
];

const PERIOD_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PERIOD_RANGE_RE = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/;

function validatePeriod(period) {
    if (!period || typeof period !== 'string') {
        return "period majburiy va string bo'lishi kerak";
    }
    if (PERIOD_MONTH_RE.test(period)) return null;
    if (PERIOD_RANGE_RE.test(period)) {
        const [start, end] = period.split('_');
        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
            return "period sanalari noto'g'ri";
        }
        if (startMs > endMs) {
            return "period: boshlang'ich sana tugash sanasidan katta";
        }
        return null;
    }
    return "period format: 'YYYY-MM' yoki 'YYYY-MM-DD_YYYY-MM-DD'";
}

function validateBody(body) {
    const errors = [];
    const periodErr = validatePeriod(body.period);
    if (periodErr) errors.push(periodErr);

    for (const key of NUMERIC_FIELDS) {
        if (body[key] === undefined || body[key] === null) continue;
        const v = body[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`${key} raqam bo'lishi kerak`);
            continue;
        }
        if (v < 0) {
            errors.push(`${key} manfiy bo'lmasligi kerak`);
        }
    }

    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        errors.push("note string bo'lishi kerak");
    }

    return errors;
}

function sanitizePlan(plan, role) {
    if (!plan || FINANCIAL_ROLES.has(role)) return plan;

    return Object.fromEntries(
        Object.entries(plan).filter(([key]) => !FINANCIAL_FIELDS.has(key))
    );
}

class PlanController {
    upsertPlan = async (req, res, next) => {
        try {
            const errors = validateBody(req.body || {});
            if (errors.length) {
                return next(ApiError.BadRequest('Validatsiya xatosi', errors));
            }

            const { period, note } = req.body;
            const update = { period };
            for (const key of NUMERIC_FIELDS) {
                if (req.body[key] !== undefined && req.body[key] !== null) {
                    update[key] = req.body[key];
                }
            }
            if (note !== undefined) update.note = note;

            const plan = await Plan.findOneAndUpdate(
                { period },
                { $set: update },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).lean();

            return res.json({ status: true, data: sanitizePlan(plan, req.user?.U_role) });
        } catch (e) {
            next(e);
        }
    };

    getPlan = async (req, res, next) => {
        try {
            const { period } = req.query;
            const periodErr = validatePeriod(period);
            if (periodErr) {
                return next(ApiError.BadRequest(periodErr));
            }

            const plan = await Plan.findOne({ period }).lean();
            if (!plan) {
                return next(ApiError.BadRequest(`'${period}' uchun plan topilmadi`));
            }

            return res.json({ status: true, data: sanitizePlan(plan, req.user?.U_role) });
        } catch (e) {
            next(e);
        }
    };
}

module.exports = new PlanController();
