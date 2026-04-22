// controllers/analytics-controller.js

const moment = require("moment-timezone");
const Lead = require("../models/lead-model");
const Branch = require("../models/branch-model");
const LeadChat = require("../models/lead-chat-model");
const Plan = require("../models/plan-model");
const dbService = require('../services/dbService');
const DataRepositories = require('../repositories/dataRepositories');

// ============================================================
//  Umumiy yordamchilar
// ============================================================
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
    if (!b || b === 0) return 0;
    const v = (a / b) * 100;
    return Number.isFinite(v) ? +v.toFixed(2) : 0;
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

// ============================================================
//  AnalyticsController
// ============================================================
class AnalyticsController {
    constructor() {
        this.sourcesList = [
            "Manychat", "Meta", "Organika", "Eski qo'ng'iroq",
            "Mehrli qo'ng'iroq", "Community", "Qayta sotuv",
            "Kiruvchi", "Chiquvchi", "Telegram bot"
        ];

        this.allPossibleStatuses = [
            'Active', 'Ignored', 'Missed', 'NoAnswer', 'FollowUp',
            'Considering', 'WillVisitStore', 'WillSendPassport',
            'Scoring', 'ScoringResult', 'VisitedStore', 'Purchased',
            'NoPurchase', 'Closed', 'Talked', 'Blocked'
        ];

        // Sifatli lead = shu statuslardan kamida bittasida (ever yoki now) bo'lgan
        this.qualityLeadStatuses = [
            'FollowUp',
            'Considering',
            'WillVisitStore',
            'WillSendPassport',
            'Scoring',
            'ScoringResult',
            'VisitedStore',
            'Purchased',
            'NoPurchase'
        ];

        // Excel'dagi funnel bosqichlari
        // prevKey -> Plan%/Fakt% oldingi bosqichga nisbatan (step conversion)
        this.stageDefs = [
            { no: 1,  key: 'lead',            name: 'Lead',                   prevKey: null },
            { no: 2,  key: 'qualityLead',     name: 'Sifatli lead',           prevKey: 'lead' },
            { no: 9,  key: 'scoringApproved', name: 'Skoringdan tasdiqlandi', prevKey: 'qualityLead' },
            { no: 10, key: 'meetingSet',      name: 'Tashrif belgilandi',     prevKey: 'scoringApproved' },
            { no: 11, key: 'willVisitStore',  name: "Do'konga boradi",        prevKey: 'meetingSet' },
            { no: 12, key: 'meetingHappened', name: "Tashrif o'tkazildi",     prevKey: 'meetingSet' },
            { no: 13, key: 'visitedStore',    name: "Do'konga keldi",         prevKey: 'meetingHappened' },
            { no: 14, key: 'contractSigned',  name: 'Shartnoma oldi',         prevKey: 'meetingHappened' }
        ];

        // Sotuv summasi uchun qaysi maydondan olish
        this.SALES_AMOUNT_FIELD = 'finalLimit';

        // bind
        this.getLeadsAnalytics = this.getLeadsAnalytics.bind(this);
        this.getLeadsFunnelByOperators = this.getLeadsFunnelByOperators.bind(this);
        this.getOperatorPerformance = this.getOperatorPerformance.bind(this);
        this.getGeneralStatusStats = this.getGeneralStatusStats.bind(this);
        this.getSourceDailyStats = this.getSourceDailyStats.bind(this);
        this.getSourceStatusDistribution = this.getSourceStatusDistribution.bind(this);
        this.getBranchPerformance = this.getBranchPerformance.bind(this);
        this.getBranchSourceStats = this.getBranchSourceStats.bind(this);
        this.getSourcePerformance = this.getSourcePerformance.bind(this);
        this.getFullFunnelAnalytics = this.getFullFunnelAnalytics.bind(this);
    }

    // ============================================================
    //  Umumiy yordamchilar (class ichida)
    // ============================================================

    _parseRange(start, end) {
        if (!start || !end) {
            const error = new Error("start va end majburiy (DD.MM.YYYY)");
            error.statusCode = 400;
            throw error;
        }
        return {
            startDate: moment.tz(start, "DD.MM.YYYY", "Asia/Tashkent").startOf("day").toDate(),
            endDate:   moment.tz(end,   "DD.MM.YYYY", "Asia/Tashkent").endOf("day").toDate()
        };
    }

    // Bir marta VisitedStore'ga tushgan barcha leadlar (eski metodlar uchun)
    async _getVisitedEverSet() {
        const visitedEver = await LeadChat.distinct('leadId', {
            action: 'status_changed',
            statusTo: 'VisitedStore'
        });
        return new Set(visitedEver.map(id => String(id)));
    }

    // Bir marta vazifalar statuslariga tushgan barcha leadlar
    async _getTasksPlanEverSet() {
        const planEver = await LeadChat.distinct('leadId', {
            action: 'status_changed',
            statusTo: { $in: ['FollowUp', 'Considering', 'WillVisitStore', 'WillSendPassport'] }
        });
        return new Set(planEver.map(id => String(id)));
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

    async _getPlanForRange(startDate, endDate) {
        const rangeKey = `${moment(startDate).format('YYYY-MM-DD')}_${moment(endDate).format('YYYY-MM-DD')}`;
        const monthKey = moment(startDate).format('YYYY-MM');

        const plan =
            (await Plan.findOne({ period: rangeKey }).lean()) ||
            (await Plan.findOne({ period: monthKey }).lean()) ||
            {};

        return {
            lead:            plan.lead            || 0,
            qualityLead:     plan.qualityLead     || 0,
            scoringApproved: plan.scoringApproved || 0,
            meetingSet:      plan.meetingSet      || 0,
            willVisitStore:  plan.willVisitStore  || 0,
            meetingHappened: plan.meetingHappened || 0,
            visitedStore:    plan.visitedStore    || 0,
            contractSigned:  plan.contractSigned  || 0,
            salesAmount:     plan.salesAmount     || 0,
            averageCheck:    plan.averageCheck    || 0,
            _periodKey:      plan.period          || null
        };
    }

    _buildStatusTimePipeline(type) {
        if (type === 'createdAt') {
            return [
                { $addFields: { actualTime: { $ifNull: ["$time", "$createdAt"] } } }
            ];
        }
        return [
            {
                $addFields: {
                    actualTime: {
                        $switch: {
                            branches: [
                                { case: { $eq: ["$status", "Purchased"] }, then: "$purchaseDate" }
                            ],
                            default: { $ifNull: ["$newTime", { $ifNull: ["$time", "$createdAt"] }] }
                        }
                    }
                }
            }
        ];
    }

    // ============================================================
    //  1. Asosiy Funnel va Manba analitikasi (current status)
    // ============================================================
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
                    { no: 1, name: 'Leads',                count: funnel.leads,       cr: 100 },
                    { no: 2, name: "Qo'ng'iroq qilindi",   count: funnel.called,      cr: percent(funnel.called, funnel.leads) },
                    { no: 3, name: 'Javob berdi',          count: funnel.answered,    cr: percent(funnel.answered, funnel.leads) },
                    { no: 4, name: 'Qiziqish bildirdi',    count: funnel.interested,  cr: percent(funnel.interested, funnel.leads) },
                    { no: 5, name: 'Pasport',              count: funnel.passport,    cr: percent(funnel.passport, funnel.leads) },
                    { no: 6, name: 'Uchrashuv belgilandi', count: funnel.meetingSet,  cr: percent(funnel.meetingSet, funnel.leads) },
                    { no: 7, name: "Vizit bo'ldi",         count: funnel.visit,       cr: percent(funnel.visit, funnel.leads) },
                    { no: 8, name: 'Jarayonda',            count: funnel.processing,  cr: percent(funnel.processing, funnel.leads) },
                    { no: 9, name: "Harid bo'ldi",         count: funnel.purchase,    cr: percent(funnel.purchase, funnel.leads) },
                ],
                sources: sourceAnalytics
            });
        } catch (err) { next(err); }
    }

    // ============================================================
    //  2. Operatorlar kesimida Funnel (current status)
    // ============================================================
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

    // ============================================================
    //  3. Operator Performance (Statuslar) + VisitedStoreOverall
    // ============================================================
    async getOperatorPerformance(req, res, next) {
        try {
            const { start, end, type = 'updatedAt' } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);
            const opMap = await this.getOperatorsMap();

            const statusTimePipeline = this._buildStatusTimePipeline(type);
            const taskStatuses = ['FollowUp', 'Considering', 'WillVisitStore', 'WillSendPassport'];

            const [stats, operatorLeads, visitedEverSet, tasksPlanEverSet, tasksByRecallDate] = await Promise.all([
                Lead.aggregate([
                    ...statusTimePipeline,
                    {
                        $match: {
                            actualTime: { $gte: startDate, $lte: endDate },
                            $and: [
                                { operator: { $ne: null } }, { operator: { $ne: "" } },
                                { operator: { $ne: 0 } },    { operator: { $exists: true } }
                            ]
                        }
                    },
                    { $group: { _id: { operator: "$operator", status: "$status" }, count: { $sum: 1 } } },
                    { $group: { _id: "$_id.operator", foundStatuses: { $push: { k: "$_id.status", v: "$count" } }, total: { $sum: "$count" } } },
                    { $sort: { total: -1 } }
                ]),
                Lead.aggregate([
                    ...statusTimePipeline,
                    {
                        $match: {
                            actualTime: { $gte: startDate, $lte: endDate },
                            $and: [
                                { operator: { $ne: null } }, { operator: { $ne: "" } },
                                { operator: { $ne: 0 } },    { operator: { $exists: true } }
                            ]
                        }
                    },
                    { $group: { _id: "$operator", leadIds: { $push: "$_id" } } }
                ]),
                this._getVisitedEverSet(),
                this._getTasksPlanEverSet(),
                Lead.aggregate([
                    {
                        $match: {
                            recallDate: { $gte: startDate, $lte: endDate },
                            $and: [
                                { operator: { $ne: null } }, { operator: { $ne: "" } },
                                { operator: { $ne: 0 } },    { operator: { $exists: true } }
                            ]
                        }
                    },
                    {
                        $group: {
                            _id: "$operator",
                            leadIds: { $push: "$_id" },
                            tasksFact: { $sum: { $cond: [{ $in: ["$status", taskStatuses] }, 1, 0] } }
                        }
                    }
                ])
            ]);

            const operatorLeadMap = Object.fromEntries(
                operatorLeads.map(o => [String(o._id), o.leadIds.map(id => String(id))])
            );

            const recallTaskMap = Object.fromEntries(
                tasksByRecallDate.map(o => [String(o._id), {
                    leadIds: o.leadIds.map(id => String(id)),
                    tasksFact: o.tasksFact
                }])
            );

            const result = stats.filter(item => opMap.has(String(item._id))).map(item => {
                const statusMap = Object.fromEntries(item.foundStatuses.map(s => [s.k, s.v]));
                const myLeadIds = operatorLeadMap[String(item._id)] || [];
                const VisitedStoreOverall = myLeadIds.filter(id => visitedEverSet.has(id)).length;
                const recallData = recallTaskMap[String(item._id)] || { leadIds: [], tasksFact: 0 };
                const TasksPlan = recallData.leadIds.filter(id => tasksPlanEverSet.has(id)).length;
                const TasksFact = recallData.tasksFact;

                const details = this.allPossibleStatuses.flatMap(st => {
                    const item_ = {
                        status: st,
                        count: statusMap[st] || 0,
                        percentage: percent(statusMap[st] || 0, item.total)
                    };
                    if (st === 'VisitedStore') {
                        return [
                            item_,
                            { status: 'VisitedStoreOverall', count: VisitedStoreOverall, percentage: percent(VisitedStoreOverall, item.total) }
                        ];
                    }
                    if (st === 'WillSendPassport') {
                        return [
                            item_,
                            { status: 'TasksPlan', count: TasksPlan, percentage: percent(TasksPlan, item.total) },
                            { status: 'TasksFact', count: TasksFact, percentage: percent(TasksFact, item.total) }
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

    // ============================================================
    //  4. Source Performance + VisitedStoreOverall
    // ============================================================
    async getSourcePerformance(req, res, next) {
        try {
            const { start, end, type = 'updatedAt' } = req.query;
            const { startDate, endDate } = this._parseRange(start, end);

            const statusTimePipeline = this._buildStatusTimePipeline(type);

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
                            { status: 'VisitedStoreOverall', count: VisitedStoreOverall, percentage: percent(VisitedStoreOverall, item.total) }
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

    // ============================================================
    //  5. Umumiy Status Stats + VisitedStoreOverall
    // ============================================================
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
                        { status: 'VisitedStoreOverall', count: VisitedStoreOverall, percentage: percent(VisitedStoreOverall, total) }
                    ];
                }
                return [item];
            });

            res.json({ status: true, total, data: result });
        } catch (err) { next(err); }
    }

    // ============================================================
    //  6. Source Daily Stats
    // ============================================================
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
                        daily: [{
                            $group: {
                                _id: { source: "$source", date: { $dateToString: { format: "%Y.%m.%d", date: "$actualTime" } } },
                                count: { $sum: 1 }
                            }
                        }]
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

    // ============================================================
    //  7. Source Status Distribution + VisitedStoreOverall
    // ============================================================
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
                            { status: 'VisitedStoreOverall', count: VisitedStoreOverall, percentage: percent(VisitedStoreOverall, dbData.total) }
                        ];
                    }
                    return [item];
                });

                return { source: sourceName, total: dbData.total, details };
            }).sort((a, b) => b.total - a.total);

            res.json({ status: true, data: result });
        } catch (err) { next(err); }
    }

    // ============================================================
    //  8. Branch Performance + VisitedStoreOverall
    // ============================================================
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
                            visitedCount: {
                                $sum: {
                                    $cond: [
                                        { $or: [
                                                { $eq: ["$status", "VisitedStore"] },
                                                { $eq: ["$meetingHappened", true] }
                                            ]},
                                        1, 0
                                    ]
                                }
                            },
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

    // ============================================================
    //  9. Do'konlar kesimida manbalar statistikasi
    // ============================================================
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
                        count,
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

    // ============================================================
    //  10. FULL FUNNEL ANALYTICS (history-based)
    //  -----------------------------------------------------------
    //  Excel'dagi to'liq funnel.
    //  Hisoblash mantiqi: bitta lead bir vaqtning o'zida bir nechta
    //  bosqichda sanalishi mumkin. Har bir bosqich uchun:
    //    allStatuses = {current status} ∪ {LeadChat.statusTo history}
    //  orqali mustaqil flag qo'yiladi.
    //
    //  GET /analytics/funnel?start=01.01.2026&end=31.01.2026
    //                        &groupBy=source|operator
    //                        &top=10
    // ============================================================
    async getFullFunnelAnalytics(req, res, next) {
        try {
            const { start, end, groupBy = 'source', top = 10 } = req.query;

            if (!['source', 'operator'].includes(groupBy)) {
                return res.status(400).json({
                    status: false,
                    message: "groupBy faqat 'source' yoki 'operator' bo'lishi mumkin"
                });
            }

            const { startDate, endDate } = this._parseRange(start, end);
            const topN = Math.max(1, Math.min(50, parseInt(top, 10) || 10));

            const plan = await this._getPlanForRange(startDate, endDate);
            const opMap = groupBy === 'operator' ? await this.getOperatorsMap() : null;

            const groupField = groupBy === 'operator' ? '$operator' : '$source';
            const groupMatch = groupBy === 'operator'
                ? { operator: { $nin: [null, '', 0] } }
                : { source: { $ne: null } };

            const qualityStatuses = this.qualityLeadStatuses;
            const SALES_AMOUNT_FIELD = this.SALES_AMOUNT_FIELD;

            const grouped = await Lead.aggregate([
                // 1) Lead vaqti
                {
                    $addFields: {
                        actualTime: {
                            $ifNull: ['$newTime', { $ifNull: ['$time', '$createdAt'] }]
                        }
                    }
                },
                // 2) Davrga tushadigan leadlarni filtrlash
                {
                    $match: {
                        actualTime: { $gte: startDate, $lte: endDate },
                        ...groupMatch
                    }
                },
                // 3) LeadChat dan status tarixini olish
                {
                    $lookup: {
                        from: 'leadchats', // Mongoose default pluralization
                        let: { lid: '$_id' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ['$leadId', '$$lid'] },
                                    action: 'status_changed',
                                    statusTo: { $nin: [null, ''] }
                                }
                            },
                            { $group: { _id: null, statuses: { $addToSet: '$statusTo' } } }
                        ],
                        as: '_statusHistory'
                    }
                },
                // 4) allStatuses = current ∪ history
                {
                    $addFields: {
                        allStatuses: {
                            $setUnion: [
                                [{ $ifNull: ['$status', 'Active'] }],
                                {
                                    $ifNull: [
                                        { $arrayElemAt: ['$_statusHistory.statuses', 0] },
                                        []
                                    ]
                                }
                            ]
                        }
                    }
                },
                // 5) Har bir bosqich uchun flag (0/1)
                {
                    $addFields: {
                        _fQualityLead: {
                            $cond: [
                                { $gt: [{ $size: { $setIntersection: ['$allStatuses', qualityStatuses] } }, 0] },
                                1, 0
                            ]
                        },
                        _fScoringApproved: {
                            $cond: [{ $in: ['ScoringResult', '$allStatuses'] }, 1, 0]
                        },
                        _fWillVisitStore: {
                            $cond: [{ $in: ['WillVisitStore', '$allStatuses'] }, 1, 0]
                        },
                        _fMeetingSet: {
                            $cond: [
                                {
                                    $or: [
                                        {
                                            $and: [
                                                { $ne: ['$meetingDate', null] },
                                                { $ne: ['$meetingDate', ''] }
                                            ]
                                        },
                                        { $in: ['WillVisitStore', '$allStatuses'] }
                                    ]
                                },
                                1, 0
                            ]
                        },
                        _fVisitedStore: {
                            $cond: [{ $in: ['VisitedStore', '$allStatuses'] }, 1, 0]
                        },
                        _fMeetingHappened: {
                            $cond: [
                                {
                                    $or: [
                                        { $eq: ['$meetingHappened', true] },
                                        { $in: ['VisitedStore', '$allStatuses'] }
                                    ]
                                },
                                1, 0
                            ]
                        },
                        _fPurchased: {
                            $cond: [
                                {
                                    $or: [
                                        { $eq: ['$purchase', true] },
                                        { $in: ['Purchased', '$allStatuses'] }
                                    ]
                                },
                                1, 0
                            ]
                        }
                    }
                },
                // 6) Guruhlash
                {
                    $group: {
                        _id: groupField,
                        lead:            { $sum: 1 },
                        qualityLead:     { $sum: '$_fQualityLead' },
                        scoringApproved: { $sum: '$_fScoringApproved' },
                        meetingSet:      { $sum: '$_fMeetingSet' },
                        willVisitStore:  { $sum: '$_fWillVisitStore' },
                        meetingHappened: { $sum: '$_fMeetingHappened' },
                        visitedStore:    { $sum: '$_fVisitedStore' },
                        contractSigned:  { $sum: '$_fPurchased' },
                        salesAmount: {
                            $sum: {
                                $cond: [
                                    { $eq: ['$_fPurchased', 1] },
                                    { $ifNull: [`$${SALES_AMOUNT_FIELD}`, 0] },
                                    0
                                ]
                            }
                        }
                    }
                }
            ]).allowDiskUse(true);

            // Totallar
            const KEYS = [
                'lead', 'qualityLead', 'scoringApproved', 'meetingSet', 'willVisitStore',
                'meetingHappened', 'visitedStore', 'contractSigned', 'salesAmount'
            ];
            const totals = grouped.reduce((acc, g) => {
                KEYS.forEach(k => (acc[k] = (acc[k] || 0) + (g[k] || 0)));
                return acc;
            }, {});

            const averageCheckFact = totals.contractSigned > 0
                ? +(totals.salesAmount / totals.contractSigned).toFixed(2)
                : 0;

            // TOP N guruhlar
            const sorted = [...grouped].sort((a, b) => b.lead - a.lead).slice(0, topN);

            const labelOf = (id) => {
                if (id === null || id === undefined || id === '') return "Noma'lum";
                if (groupBy === 'operator') return opMap.get(String(id)) || `#${id}`;
                return id;
            };

            // Stages
            const stages = this.stageDefs.map(stage => {
                const fact = totals[stage.key] || 0;
                const planVal = plan[stage.key] || 0;
                const prevPlan = stage.prevKey ? (plan[stage.prevKey] || 0) : planVal;
                const prevFact = stage.prevKey ? (totals[stage.prevKey] || 0) : fact;

                return {
                    no: stage.no,
                    key: stage.key,
                    name: stage.name,
                    plan: planVal,
                    planPercent:        percent(planVal, stage.prevKey ? prevPlan : planVal),
                    fact,
                    factPercent:        percent(fact, stage.prevKey ? prevFact : fact),
                    achievementPercent: percent(fact, planVal),
                    groups: sorted.map(g => {
                        const count = g[stage.key] || 0;
                        return {
                            id: g._id,
                            name: labelOf(g._id),
                            count,
                            sharePercent: percent(count, fact)
                        };
                    })
                };
            });

            // Summary
            const summary = {
                salesAmount: {
                    plan: plan.salesAmount || 0,
                    fact: totals.salesAmount || 0,
                    achievementPercent: percent(totals.salesAmount, plan.salesAmount),
                    groups: sorted.map(g => ({
                        id: g._id,
                        name: labelOf(g._id),
                        amount: g.salesAmount || 0,
                        sharePercent: percent(g.salesAmount, totals.salesAmount)
                    }))
                },
                averageCheck: {
                    plan: plan.averageCheck || 0,
                    fact: averageCheckFact,
                    groups: sorted.map(g => ({
                        id: g._id,
                        name: labelOf(g._id),
                        amount: g.contractSigned > 0
                            ? +(g.salesAmount / g.contractSigned).toFixed(2)
                            : 0
                    }))
                }
            };

            return res.json({
                status: true,
                range: { start, end },
                groupBy,
                topN,
                basis: 'history',
                planSource: plan._periodKey,
                totals,
                stages,
                summary
            });
        } catch (err) {
            next(err);
        }
    }
}

module.exports = new AnalyticsController();