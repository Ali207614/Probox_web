const moment = require("moment-timezone");
const Lead = require("../models/lead-model");
const Branch = require("../models/branch-model");
const LeadChat = require("../models/lead-chat-model");
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

const getTimePipeline = () => [
    {
        $addFields: {
            actualTime: {
                $ifNull: ["$newTime", { $ifNull: ["$time", "$createdAt"] }]
            }
        }
    }
];

function percent(a, b) {
    return (!b || b === 0) ? 0 : +(a / b * 100).toFixed(2);
}

function buildDayList(start, end) {
    const days = [];
    let current = moment(start);
    const last = moment(end);
    while (current <= last) {
        days.push(current.format("YYYY.MM.DD"));
        current.add(1, "day");
    }
    return days;
}

class AnalyticsController {
    constructor() {
        this.sourcesList = [
            "Manychat", "Meta", "Organika", "Eski qo'ng'iroq",
            "Mehrli qo'ng'iroq", "Community", "Qayta sotuv",
            "Kiruvchi", "Chiquvchi", "Telegram bot"
        ];

        this.allPossibleStatuses = [
            'Active',           // 1. Yangi lead
            'Ignored',          // 2. E'tiborsiz
            'Missed',           // 3. O'tkazib yuborildi
            'NoAnswer',         // 4. Javob bermadi
            'FollowUp',        // 5. Qayta aloqa
            'Considering',      // 6. O'ylab ko'radi
            'WillVisitStore',   // 7. Do'konga boradi
            'WillSendPassport', // 8. Pasport yuboradi
            'Scoring',          // 9. Skoring
            'ScoringResult',    // 10. Skoring natija
            'VisitedStore',     // 11. Do'konga keldi
            'Purchased',        // 12. Xarid bo'ldi
            'NoPurchase',       // 13. Xarid bo'lmadi
            'Closed',           // 14. Sifatsiz
            'Talked',           // 15. Suhbatlashildi
            'Blocked',          // 16. Bloklangan
        ];

        this.getLeadsAnalytics = this.getLeadsAnalytics.bind(this);
        this.getLeadsFunnelByOperators = this.getLeadsFunnelByOperators.bind(this);
        this.getOperatorPerformance = this.getOperatorPerformance.bind(this);
        this.getGeneralStatusStats = this.getGeneralStatusStats.bind(this);
        this.getSourceDailyStats = this.getSourceDailyStats.bind(this);
        this.getSourceStatusDistribution = this.getSourceStatusDistribution.bind(this);
        this.getBranchPerformance = this.getBranchPerformance.bind(this);
        this.getBranchSourceStats = this.getBranchSourceStats.bind(this);
        this.getSourcePerformance = this.getSourcePerformance.bind(this);
    }

    // ✅ Umumiy yordamchi: bir marta VisitedStore'ga tushgan barcha leadlar
    async _getVisitedEverSet() {
        const visitedEver = await LeadChat.distinct('leadId', {
            action: 'status_changed',
            statusTo: 'VisitedStore'
        });
        return new Set(visitedEver.map(id => String(id)));
    }

    async getOperatorsMap() {
        try {
            const sql = DataRepositories.getSalesPersons({
                include: ['Operator1', 'Operator2', 'Seller', 'Manager']
            });
            const data = await dbService.execute(sql);
            const opMap = new Map();
            if (Array.isArray(data)) {
                data.forEach(op => opMap.set(String(op.SlpCode), op.SlpName));
            }
            return opMap;
        } catch (err) {
            console.error('[Analytics] SAP Error:', err.message);
            return new Map();
        }
    }

    _parseRange(start, end) {
        if (!start || !end) {
            const error = new Error("start va end majburiy (DD.MM.YYYY)");
            error.statusCode = 400;
            throw error;
        }
        return {
            startDate: moment.tz(start, "DD.MM.YYYY", "Asia/Tashkent").startOf("day").toDate(),
            endDate: moment.tz(end, "DD.MM.YYYY", "Asia/Tashkent").endOf("day").toDate()
        };
    }

    // 1. Asosiy Funnel va Branch Analitikasi
    async getLeadsAnalytics(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);

            const leads = await Lead.aggregate([
                ...getTimePipeline(),
                { $match: { actualTime: { $gte: startDate, $lte: endDate } } }
            ]);

            const funnel = {
                leads: leads.length,
                called: leads.filter(l => l.called).length,
                answered: leads.filter(l => l.answered).length,
                interested: leads.filter(l => l.interested).length,
                passport: leads.filter(l => l.passportVisit === "Passport").length,
                meetingSet: leads.filter(l => l.meetingDate).length,
                visit: leads.filter(l => l.meetingHappened).length,
                processing: leads.filter(l => l.status === 'Scoring').length,
                purchase: leads.filter(l => l.purchase).length,
            };

            const dayList = buildDayList(startDate, endDate);
            const sourceAnalytics = this.sourcesList.map(src => {
                const filtered = leads.filter(l => l.source === src);
                return {
                    source: src,
                    count: filtered.length,
                    percent: percent(filtered.length, leads.length),
                    per_day: dayList.map(d => ({
                        day: d,
                        count: filtered.filter(l => moment(l.actualTime).format("YYYY.MM.DD") === d).length
                    }))
                };
            }).sort((a, b) => b.count - a.count);

            res.json({
                status: true,
                range: { start, end },
                funnel: [
                    { no: 1, name: 'Leads', count: funnel.leads, cr: 100 },
                    { no: 2, name: 'Qo\'ng\'iroq qilindi', count: funnel.called, cr: percent(funnel.called, funnel.leads) },
                    { no: 3, name: 'Javob berdi', count: funnel.answered, cr: percent(funnel.answered, funnel.leads) },
                    { no: 4, name: 'Qiziqish bildirdi', count: funnel.interested, cr: percent(funnel.interested, funnel.leads) },
                    { no: 5, name: 'Pasport', count: funnel.passport, cr: percent(funnel.passport, funnel.leads) },
                    { no: 6, name: 'Uchrashuv belgilandi', count: funnel.meetingSet, cr: percent(funnel.meetingSet, funnel.leads) },
                    { no: 7, name: 'Vizit bo\'ldi', count: funnel.visit, cr: percent(funnel.visit, funnel.leads) },
                    { no: 8, name: 'Jarayonda', count: funnel.processing, cr: percent(funnel.processing, funnel.leads) },
                    { no: 9, name: 'Harid bo\'ldi', count: funnel.purchase, cr: percent(funnel.purchase, funnel.leads) },
                ],
                sources: sourceAnalytics
            });
        } catch (err) { next(err); }
    }

    // 2. Operatorlar kesimida Funnel
    async getLeadsFunnelByOperators(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);
            const opMap = await this.getOperatorsMap();

            const rows = await Lead.aggregate([
                ...getTimePipeline(),
                { $match: { actualTime: { $gte: startDate, $lte: endDate } } },
                {
                    $group: {
                        _id: { $ifNull: ["$operator", "Belgilanmagan"] },
                        leads: { $sum: 1 },
                        called: { $sum: { $cond: ["$called", 1, 0] } },
                        answered: { $sum: { $cond: ["$answered", 1, 0] } },
                        interested: { $sum: { $cond: ["$interested", 1, 0] } },
                        passport: { $sum: { $cond: [{ $eq: ["$passportVisit", "Passport"] }, 1, 0] } },
                        meetingSet: { $sum: { $cond: [{ $and: ["$meetingDate", { $ne: ["$meetingDate", ""] }] }, 1, 0] } },
                        visit: { $sum: { $cond: ["$meetingHappened", 1, 0] } },
                        processing: { $sum: { $cond: [{ $eq: ["$status", "Scoring"] }, 1, 0] } },
                        purchase: { $sum: { $cond: ["$purchase", 1, 0] } },
                    }
                },
                { $sort: { leads: -1 } }
            ]);

            const result = rows.map(r => ({
                operatorName: opMap.get(String(r._id)) || r._id,
                totals: r,
                funnel: [
                    { no: 1, name: "Leads", count: r.leads, cr: 100 },
                    { no: 9, name: "Harid bo'ldi", count: r.purchase, cr: percent(r.purchase, r.leads) }
                ]
            }));

            res.json({ status: true, data: result });
        } catch (err) { next(err); }
    }

    // 3. Operator Performance (Statuslar) + VisitedStoreOverall
    async getOperatorPerformance(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);
            const opMap = await this.getOperatorsMap();

            const statusTimePipeline = [
                {
                    $addFields: {
                        actualTime: {
                            $switch: {
                                branches: [
                                    {
                                        case: { $eq: ["$status", "VisitedStore"] },
                                        then: { $ifNull: ["$newTime", { $ifNull: ["$time", "$createdAt"] }] }
                                    },
                                    {
                                        case: { $eq: ["$status", "Purchased"] },
                                        then: "$purchaseDate"
                                    },
                                    {
                                        case: { $eq: ["$status", "Talked"] },
                                        then: { $ifNull: ["$newTime", { $ifNull: ["$time", "$createdAt"] }] }
                                    }
                                ],
                                default: { $ifNull: ["$time", "$createdAt"] }
                            }
                        }
                    }
                }
            ];

            const [stats, operatorLeads, visitedEverSet] = await Promise.all([
                Lead.aggregate([
                    ...statusTimePipeline,
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, $and: [{ operator: { $ne: null } }, { operator: { $ne: "" } }, { operator: { $exists: true } }] } },
                    { $group: { _id: { operator: "$operator", status: "$status" }, count: { $sum: 1 } } },
                    { $group: { _id: "$_id.operator", foundStatuses: { $push: { k: "$_id.status", v: "$count" } }, total: { $sum: "$count" } } },
                    { $sort: { total: -1 } }
                ]),
                Lead.aggregate([
                    ...statusTimePipeline,
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, $and: [{ operator: { $ne: null } }, { operator: { $ne: "" } }, { operator: { $exists: true } }] } },
                    { $group: { _id: "$operator", leadIds: { $push: "$_id" } } }
                ]),
                this._getVisitedEverSet()
            ]);

            const operatorLeadMap = Object.fromEntries(
                operatorLeads.map(o => [String(o._id), o.leadIds.map(id => String(id))])
            );

            const result = stats.map(item => {
                const statusMap = Object.fromEntries(item.foundStatuses.map(s => [s.k, s.v]));
                const myLeadIds = operatorLeadMap[String(item._id)] || [];
                const VisitedStoreOverall = myLeadIds.filter(id => visitedEverSet.has(id)).length;

                const details = this.allPossibleStatuses.flatMap(st => {
                    const item_ = {
                        status: st,
                        count: statusMap[st] || 0,
                        percentage: percent(statusMap[st] || 0, item.total)
                    };
                    if (st === 'VisitedStore') {
                        return [
                            item_,
                            {
                                status: 'VisitedStoreOverall',
                                count: VisitedStoreOverall,
                                percentage: percent(VisitedStoreOverall, item.total)
                            }
                        ];
                    }
                    return [item_];
                });

                return {
                    slpCode: item._id,
                    operatorName: opMap.get(String(item._id)) || "Noma'lum",
                    total: item.total,
                    details
                };
            });

            res.json({ status: true, data: result });
        } catch (err) { next(err); }
    }

    // 4. Source Performance + VisitedStoreOverall
    async getSourcePerformance(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);

            const statusTimePipeline = [
                {
                    $addFields: {
                        actualTime: {
                            $switch: {
                                branches: [
                                    {
                                        case: { $eq: ["$status", "VisitedStore"] },
                                        then: { $ifNull: ["$newTime", { $ifNull: ["$time", "$createdAt"] }] }
                                    },
                                    {
                                        case: { $eq: ["$status", "Purchased"] },
                                        then: "$purchaseDate"
                                    },
                                    {
                                        case: { $eq: ["$status", "Talked"] },
                                        then: { $ifNull: ["$newTime", { $ifNull: ["$time", "$createdAt"] }] }
                                    }
                                ],
                                default: { $ifNull: ["$time", "$createdAt"] }
                            }
                        }
                    }
                }
            ];

            const [stats, sourceLeads, visitedEverSet] = await Promise.all([
                Lead.aggregate([
                    ...statusTimePipeline,
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, source: { $ne: null } } },
                    { $group: { _id: { source: "$source", status: "$status" }, count: { $sum: 1 } } },
                    { $group: { _id: "$_id.source", foundStatuses: { $push: { k: "$_id.status", v: "$count" } }, total: { $sum: "$count" } } },
                    { $sort: { total: -1 } }
                ]),
                Lead.aggregate([
                    ...statusTimePipeline,
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, source: { $ne: null } } },
                    { $group: { _id: "$source", leadIds: { $push: "$_id" } } }
                ]),
                this._getVisitedEverSet()
            ]);

            const sourceLeadMap = Object.fromEntries(
                sourceLeads.map(s => [String(s._id), s.leadIds.map(id => String(id))])
            );

            const result = stats.map(item => {
                const statusMap = Object.fromEntries(item.foundStatuses.map(s => [s.k, s.v]));
                const myLeadIds = sourceLeadMap[String(item._id)] || [];
                const VisitedStoreOverall = myLeadIds.filter(id => visitedEverSet.has(id)).length;

                const details = this.allPossibleStatuses.flatMap(st => {
                    const item_ = {
                        status: st,
                        count: statusMap[st] || 0,
                        percentage: percent(statusMap[st] || 0, item.total)
                    };
                    if (st === 'VisitedStore') {
                        return [
                            item_,
                            {
                                status: 'VisitedStoreOverall',
                                count: VisitedStoreOverall,
                                percentage: percent(VisitedStoreOverall, item.total)
                            }
                        ];
                    }
                    return [item_];
                });

                return {
                    source: item._id || "Noma'lum",
                    total: item.total,
                    details
                };
            });

            res.json({ status: true, data: result });
        } catch (err) { next(err); }
    }

    // 5. Umumiy Status Stats + VisitedStoreOverall
    async getGeneralStatusStats(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);

            const [stats, allLeadIds, visitedEverSet] = await Promise.all([
                Lead.aggregate([
                    ...getTimePipeline(),
                    { $match: { actualTime: { $gte: startDate, $lte: endDate } } },
                    { $group: { _id: "$status", count: { $sum: 1 } } }
                ]),
                Lead.aggregate([
                    ...getTimePipeline(),
                    { $match: { actualTime: { $gte: startDate, $lte: endDate } } },
                    { $group: { _id: null, leadIds: { $push: "$_id" } } }
                ]),
                this._getVisitedEverSet()
            ]);

            const total = stats.reduce((acc, curr) => acc + curr.count, 0);
            const statsMap = Object.fromEntries(stats.map(s => [s._id, s.count]));

            const ids = (allLeadIds[0]?.leadIds || []).map(id => String(id));
            const VisitedStoreOverall = ids.filter(id => visitedEverSet.has(id)).length;

            const result = this.allPossibleStatuses.flatMap(st => {
                const item = {
                    status: st,
                    count: statsMap[st] || 0,
                    percentage: percent(statsMap[st] || 0, total)
                };
                if (st === 'VisitedStore') {
                    return [
                        item,
                        {
                            status: 'VisitedStoreOverall',
                            count: VisitedStoreOverall,
                            percentage: percent(VisitedStoreOverall, total)
                        }
                    ];
                }
                return [item];
            });

            res.json({ status: true, total, data: result });
        } catch (err) { next(err); }
    }

    // 6. Source Daily Stats
    async getSourceDailyStats(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);
            const dayList = buildDayList(startDate, endDate);

            const stats = await Lead.aggregate([
                ...getTimePipeline(),
                { $match: { actualTime: { $gte: startDate, $lte: endDate }, source: { $in: this.sourcesList } } },
                {
                    $facet: {
                        overall: [{ $group: { _id: "$source", count: { $sum: 1 } } }],
                        daily: [{ $group: { _id: { source: "$source", date: { $dateToString: { format: "%Y.%m.%d", date: "$actualTime" } } }, count: { $sum: 1 } } }]
                    }
                }
            ]);

            const overallMap = Object.fromEntries((stats[0].overall || []).map(o => [o._id, o.count]));
            const dailyMap = new Map((stats[0].daily || []).map(d => [`${d._id.source}_${d._id.date}`, d.count]));
            const totalAll = Object.values(overallMap).reduce((a, b) => a + b, 0);

            const result = this.sourcesList.map(sourceName => ({
                source: sourceName,
                count: overallMap[sourceName] || 0,
                percentage: percent(overallMap[sourceName] || 0, totalAll),
                per_day: dayList.map(day => ({ day, count: dailyMap.get(`${sourceName}_${day}`) || 0 }))
            })).sort((a, b) => b.count - a.count);

            res.json({ status: true, total: totalAll, data: result });
        } catch (err) { next(err); }
    }

    // 7. Source Status Distribution + VisitedStoreOverall
    async getSourceStatusDistribution(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);

            const [stats, sourceLeads, visitedEverSet] = await Promise.all([
                Lead.aggregate([
                    ...getTimePipeline(),
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, source: { $in: this.sourcesList } } },
                    { $group: { _id: { source: "$source", status: "$status" }, count: { $sum: 1 } } },
                    { $group: { _id: "$_id.source", foundStats: { $push: { k: "$_id.status", v: "$count" } }, total: { $sum: "$count" } } }
                ]),
                Lead.aggregate([
                    ...getTimePipeline(),
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, source: { $in: this.sourcesList } } },
                    { $group: { _id: "$source", leadIds: { $push: "$_id" } } }
                ]),
                this._getVisitedEverSet()
            ]);

            const statsMap = Object.fromEntries(stats.map(s => [s._id, s]));
            const sourceLeadMap = Object.fromEntries(
                sourceLeads.map(s => [String(s._id), s.leadIds.map(id => String(id))])
            );

            const result = this.sourcesList.map(sourceName => {
                const dbData = statsMap[sourceName] || { total: 0, foundStats: [] };
                const foundMap = Object.fromEntries(dbData.foundStats.map(f => [f.k, f.v]));
                const myLeadIds = sourceLeadMap[sourceName] || [];
                const VisitedStoreOverall = myLeadIds.filter(id => visitedEverSet.has(id)).length;

                const details = this.allPossibleStatuses.flatMap(st => {
                    const item = {
                        status: st,
                        count: foundMap[st] || 0,
                        percentage: percent(foundMap[st] || 0, dbData.total)
                    };
                    if (st === 'VisitedStore') {
                        return [
                            item,
                            {
                                status: 'VisitedStoreOverall',
                                count: VisitedStoreOverall,
                                percentage: percent(VisitedStoreOverall, dbData.total)
                            }
                        ];
                    }
                    return [item];
                });

                return {
                    source: sourceName,
                    total: dbData.total,
                    details
                };
            }).sort((a, b) => b.total - a.total);

            res.json({ status: true, data: result });
        } catch (err) { next(err); }
    }

    // 8. Branch Performance + VisitedStoreOverall
    async getBranchPerformance(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);
            const allBranches = await Branch.find({}).lean();

            const [stats, branchLeads, visitedEverSet] = await Promise.all([
                Lead.aggregate([
                    ...getTimePipeline(),
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, branch2: { $ne: null } } },
                    {
                        $group: {
                            _id: "$branch2",
                            visitedCount: { $sum: { $cond: [{ $or: [{ $eq: ["$status", "VisitedStore"] }, { $eq: ["$meetingHappened", true] }] }, 1, 0] } },
                            purchasedCount: { $sum: { $cond: ["$purchase", 1, 0] } },
                            totalLeads: { $sum: 1 }
                        }
                    }
                ]),
                Lead.aggregate([
                    ...getTimePipeline(),
                    { $match: { actualTime: { $gte: startDate, $lte: endDate }, branch2: { $ne: null } } },
                    { $group: { _id: "$branch2", leadIds: { $push: "$_id" } } }
                ]),
                this._getVisitedEverSet()
            ]);

            const statsMap = Object.fromEntries(stats.map(s => [String(s._id), s]));
            const branchLeadMap = Object.fromEntries(
                branchLeads.map(b => [String(b._id), b.leadIds.map(id => String(id))])
            );

            const result = allBranches.map(branch => {
                const data = statsMap[String(branch.id)] || { visitedCount: 0, purchasedCount: 0, totalLeads: 0 };
                const myLeadIds = branchLeadMap[String(branch.id)] || [];
                const VisitedStoreOverall = myLeadIds.filter(id => visitedEverSet.has(id)).length;

                return {
                    branchName: branch.name,
                    totalLeads: data.totalLeads,
                    visitedCount: data.visitedCount,
                    VisitedStoreOverall,
                    purchasedCount: data.purchasedCount,
                    conversionToPurchase: percent(data.purchasedCount, VisitedStoreOverall),
                    totalConversion: percent(data.purchasedCount, data.totalLeads)
                };
            }).sort((a, b) => b.purchasedCount - a.purchasedCount);

            res.json({ status: true, data: result });
        } catch (err) { next(err); }
    }

    // 9. Do'konlar kesimida manbalar statistikasi
    async getBranchSourceStats(req, res, next) {
        try {
            const { start, end } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);
            const allBranches = await Branch.find({}).lean();

            const stats = await Lead.aggregate([
                ...getTimePipeline(),
                {
                    $match: {
                        actualTime: { $gte: startDate, $lte: endDate },
                        branch2: { $ne: null },
                        source: { $in: this.sourcesList }
                    }
                },
                { $group: { _id: { branch: "$branch2", source: "$source" }, count: { $sum: 1 } } },
                { $group: { _id: "$_id.branch", sources: { $push: { k: "$_id.source", v: "$count" } }, totalLeads: { $sum: "$count" } } }
            ]);

            const statsMap = Object.fromEntries(stats.map(s => [String(s._id), s]));

            const result = allBranches.map(branch => {
                const dbData = statsMap[String(branch.id)] || { totalLeads: 0, sources: [] };
                const foundSourcesMap = Object.fromEntries(dbData.sources.map(s => [s.k, s.v]));

                const sourceDetails = this.sourcesList.map(srcName => {
                    const count = foundSourcesMap[srcName] || 0;
                    return {
                        source: srcName,
                        count: count,
                        percentage: percent(count, dbData.totalLeads)
                    };
                });

                return {
                    branchId: branch.id,
                    branchName: branch.name,
                    totalLeads: dbData.totalLeads,
                    sources: sourceDetails
                };
            }).sort((a, b) => b.totalLeads - a.totalLeads);

            res.json({ status: true, range: { start, end }, data: result });
        } catch (err) { next(err); }
    }
}

module.exports = new AnalyticsController();