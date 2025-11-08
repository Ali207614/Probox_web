// utils/assignBalancedOperator.js
const LeadModel = require('../models/lead-model');

const moment = require('moment');

async function assignBalancedOperator() {
    const DataRepositories = require('../repositories/dataRepositories');
    const b1Controller = require('../controllers/b1HANA');

    const query = DataRepositories.getSalesPersons({ include: ['Operator1'] });
    const operators = await b1Controller.execute(query);

    if (!operators?.length) {
        throw new Error('No operators found in SAP');
    }

    // 2️⃣ Ish kuni filtri
    const weekday = moment().isoWeekday().toString();
    const availableOperators = operators.filter(
        (op) => op.U_workDay && op.U_workDay.includes(weekday)
    );

    const activeOperators = availableOperators.length ? availableOperators : operators;

    // 3️⃣ Bugungi kunda nechta lead berilganini hisoblash
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

    // 4️⃣ Operator bo‘yicha hisob jadvalini tuzish
    const countMap = new Map();
    stats.forEach((s) => countMap.set(s._id, s.count));

    // 5️⃣ Eng kam band operatorni topish
    let selected = activeOperators[0];
    let minCount = countMap.get(selected.SlpCode) || 0;

    for (const op of activeOperators) {
        const count = countMap.get(op.SlpCode) || 0;
        if (count < minCount) {
            selected = op;
            minCount = count;
        }
    }

    return selected.SlpCode;
}

module.exports = assignBalancedOperator;
