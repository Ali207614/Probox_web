const moment = require('moment');
const LeadModel = require('../models/lead-model');

let lastAssignedIndex = 0;

async function assignBalancedOperator() {
    const DataRepositories = require('../repositories/dataRepositories');
    const b1Controller = require('../controllers/b1HANA');
    const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
    const operators = await b1Controller.execute(query);

    if (!operators?.length) {
        throw new Error('No operators found in SAP');
    }

    const now = moment();
    let weekday;
    if (now.hour() >= 19) {
        weekday = moment().add(1, 'day').isoWeekday().toString();
    } else {
        weekday = moment().isoWeekday().toString();
    }

    const availableOperators = operators.filter(
        (op) => op?.U_workDay && op.U_workDay.includes(weekday)
    );

    const activeOperators = availableOperators.length ? availableOperators : operators;

    const startOfDay = moment().startOf('day').toDate();
    const endOfDay = moment().endOf('day').toDate();

    const stats = await LeadModel.aggregate([
        {
            $match: {
                operator: { $in: activeOperators.map((op) => op.SlpCode) },
                createdAt: { $gte: startOfDay, $lte: endOfDay },
            },
        },
        {
            $group: {
                _id: '$operator',
                count: { $sum: 1 },
            },
        },
    ]);

    const countMap = new Map(stats.map((s) => [s._id, s.count]));

    let minCount = Infinity;
    for (const op of activeOperators) {
        const count = countMap.get(op.SlpCode) || 0;
        if (count < minCount) minCount = count;
    }

    const leastLoaded = activeOperators.filter(
        (op) => (countMap.get(op.SlpCode) || 0) === minCount
    );

    if (leastLoaded.length > 1) {
        const selected = leastLoaded[lastAssignedIndex % leastLoaded.length];
        lastAssignedIndex++;
        return selected.SlpCode;
    }

    return leastLoaded[0].SlpCode;
}

module.exports = assignBalancedOperator;
