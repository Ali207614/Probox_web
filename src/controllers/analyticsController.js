const moment = require("moment-timezone");
const Lead = require("../models/lead-model");

class AnalyticsController {
    getLeadsAnalytics = async (req, res, next) => {
        try {
            const { start, end } = req.query;

            if (!start || !end) {
                return res.status(400).json({ message: "start va end majburiy" });
            }

            // 1) DATE PARSE (Asia/Tashkent, dot format)
            const startDate = moment.tz(start, "DD.MM.YYYY", "Asia/Tashkent")
                .startOf("day").toDate();

            const endDate = moment.tz(end, "DD.MM.YYYY", "Asia/Tashkent")
                .endOf("day").toDate();

            // 2) LEADS FETCH
            const leads = await Lead.find({
                time: { $gte: startDate, $lte: endDate }
            }).lean();


            // ================================
            //  ANALITIKA 1: FUNNEL
            // ================================
            const funnel = {
                leads: leads.length,
                called: leads.filter(l => l.called).length,
                answered: leads.filter(l => l.answered).length,
                interested: leads.filter(l => l.interested).length,
                passport: leads.filter(l => l.passportVisit === "Passport").length,
                meetingSet: leads.filter(l => l.meetingDate).length,
                visit: leads.filter(l => l.meetingHappened).length,
                processing: leads.filter(l => l.passportVisit === 'Processing').length,
                purchase: leads.filter(l => l.purchase).length,
            };

            const funnelFinal = [
                { no: 1, name: 'Leads', count: funnel.leads, cr: 100 },
                { no: 2, name: 'Qo‘ng‘iroq qilindi', count: funnel.called, cr: percent(funnel.called, funnel.leads) },
                { no: 3, name: 'Javob berdi', count: funnel.answered, cr: percent(funnel.answered, funnel.leads) },
                { no: 4, name: 'Qiziqish bildirdi', count: funnel.interested, cr: percent(funnel.interested, funnel.leads) },
                { no: 5, name: 'Pasport', count: funnel.passport, cr: percent(funnel.passport, funnel.leads) },
                { no: 6, name: 'Uchrashuv belgilandi', count: funnel.meetingSet, cr: percent(funnel.meetingSet, funnel.leads) },
                { no: 7, name: 'Vizit bo\'ldi', count: funnel.visit, cr: percent(funnel.visit, funnel.leads) },
                { no: 8, name: 'Jarayonda', count: funnel.processing, cr: percent(funnel.processing, funnel.leads) },
                { no: 9, name: 'Harid bo\'ldi', count: funnel.purchase, cr: percent(funnel.purchase, funnel.leads) },
            ];




            const dayList = buildDayList(startDate, endDate);

            const sourceMap = {};

            for (const lead of leads) {
                const src = lead.source || "Unknown";

                if (!sourceMap[src]) {
                    sourceMap[src] = {
                        total: 0,
                        per_day: dayList.map(d => ({ day: d, count: 0 }))
                    };
                }

                sourceMap[src].total += 1;

                const dayStr = moment(lead.time).format("YYYY.MM.DD");

                const idx = sourceMap[src].per_day.findIndex(d => d.day === dayStr);
                if (idx >= 0) {
                    sourceMap[src].per_day[idx].count += 1;
                }
            }

            const totalSources = leads.length;
            const sourceAnalytics = Object.keys(sourceMap).map(src => ({
                source: src,
                count: sourceMap[src].total,
                percent: percent(sourceMap[src].total, totalSources),
                per_day: sourceMap[src].per_day
            }));

            const branches = [
                { id: 1, name: "Qoratosh" },
                { id: 2, name: "Sagbon" },
                { id: 3, name: "Parkent" }
            ];

            const branchLookup = {};
            branches.forEach(b => branchLookup[b.id] = b.name);

            const branchMap = {};
            branches.forEach(b => {
                branchMap[b.id] = {
                    id: b.id,
                    name: b.name,
                    total: 0,
                    per_day: dayList.map(d => ({ day: d, count: 0 }))
                };
            });

            for (const lead of leads) {
                const b = Number(lead.branch2);

                if (!branchMap[b]) continue;

                branchMap[b].total++;

                const dayStr = moment(lead.time).format("YYYY.MM.DD");
                const idx = branchMap[b].per_day.findIndex(d => d.day === dayStr);
                if (idx >= 0) branchMap[b].per_day[idx].count++;
            }

            const totalBranches = Object.values(branchMap)
                .reduce((acc, b) => acc + b.total, 0);

            const branchAnalytics = Object.values(branchMap).map(b => ({
                branch_id: b.id,
                branch_name: b.name,
                count: b.total,
                percent: percent(b.total, totalBranches),
                per_day: b.per_day
            }));




            // =====================================
            //  SEND RESPONSE
            // =====================================
            return res.json({
                status: true,
                range: { start, end },
                analytics1_funnel: funnelFinal,
                analytics2_sources: sourceAnalytics,
                analytics3_branches: branchAnalytics,
            });

        } catch (err) {
            next(err);
        }
    };

    getLeadsFunnelByOperators = async (req, res, next) => {
        try {
            const { start, end } = req.query;

            if (!start || !end) {
                return res.status(400).json({ message: "start va end majburiy" });
            }

            const startDate = moment.tz(start, "DD.MM.YYYY", "Asia/Tashkent").startOf("day").toDate();
            const endDate   = moment.tz(end, "DD.MM.YYYY", "Asia/Tashkent").endOf("day").toDate();

            // operator field (sizda operator ext / operator1 bo'lishi mumkin)
            const OP_FIELD = "operator1"; // <- kerak bo'lsa: "pbx.operator_ext" yoki "operator"

            const rows = await Lead.aggregate([
                {
                    $match: {
                        time: { $gte: startDate, $lte: endDate },
                    },
                },

                // operator yo'q bo'lsa "Unknown"
                {
                    $addFields: {
                        __op: { $ifNull: [`$${OP_FIELD}`, "Unknown"] },
                    },
                },

                {
                    $group: {
                        _id: "$__op",

                        leads: { $sum: 1 },

                        called: {
                            $sum: { $cond: [{ $eq: ["$called", true] }, 1, 0] },
                        },
                        answered: {
                            $sum: { $cond: [{ $eq: ["$answered", true] }, 1, 0] },
                        },
                        interested: {
                            $sum: { $cond: [{ $eq: ["$interested", true] }, 1, 0] },
                        },

                        // old logic: passportVisit === "Passport"
                        passport: {
                            $sum: { $cond: [{ $eq: ["$passportVisit", "Passport"] }, 1, 0] },
                        },

                        meetingSet: {
                            $sum: {
                                $cond: [
                                    {
                                        // meetingDate borligini tekshirish
                                        $and: [
                                            { $ne: ["$meetingDate", null] },
                                            { $ne: ["$meetingDate", ""] },
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },

                        visit: {
                            $sum: { $cond: [{ $eq: ["$meetingHappened", true] }, 1, 0] },
                        },

                        // siz endi status enum’ni yangilayapsiz.
                        // oldingisi: passportVisit === 'Processing' edi.
                        // yangi enum’da "Scoring" yoki shunga o'xshash bo'lsa, shu yerda tekshiring.
                        // Masalan: status === 'Scoring'
                        processing: {
                            $sum: { $cond: [{ $eq: ["$status", "Scoring"] }, 1, 0] },
                        },

                        // old logic: purchase boolean
                        purchase: {
                            $sum: { $cond: [{ $eq: ["$purchase", true] }, 1, 0] },
                        },
                    },
                },

                { $sort: { leads: -1 } },
            ]);

            const result = rows.map(r => {
                const leads = r.leads || 0;

                const funnelFinal = [
                    { no: 1, name: "Leads", count: leads, cr: leads ? 100 : 0 },
                    { no: 2, name: "Qo‘ng‘iroq qilindi", count: r.called, cr: percent(r.called, leads) },
                    { no: 3, name: "Javob berdi", count: r.answered, cr: percent(r.answered, leads) },
                    { no: 4, name: "Qiziqish bildirdi", count: r.interested, cr: percent(r.interested, leads) },
                    { no: 5, name: "Pasport", count: r.passport, cr: percent(r.passport, leads) },
                    { no: 6, name: "Uchrashuv belgilandi", count: r.meetingSet, cr: percent(r.meetingSet, leads) },
                    { no: 7, name: "Vizit bo'ldi", count: r.visit, cr: percent(r.visit, leads) },
                    { no: 8, name: "Jarayonda", count: r.processing, cr: percent(r.processing, leads) },
                    { no: 9, name: "Harid bo'ldi", count: r.purchase, cr: percent(r.purchase, leads) },
                ];

                return {
                    operator: r._id,          // masalan: 2
                    totals: {
                        leads: r.leads,
                        called: r.called,
                        answered: r.answered,
                        interested: r.interested,
                        passport: r.passport,
                        meetingSet: r.meetingSet,
                        visit: r.visit,
                        processing: r.processing,
                        purchase: r.purchase,
                    },
                    funnel: funnelFinal,
                };
            });

            return res.json({
                status: true,
                range: { start, end },
                analytics1_funnel_by_operators: result,
            });
        } catch (err) {
            next(err);
        }
    };

}


function percent(a, b) {
    if (!b || b === 0) return 0;
    return +(a / b * 100).toFixed(2);
}

function buildDayList(start, end) {
    const days = [];
    let current = moment(start);

    const last = moment(end);

    while (current <= last) {
        days.push(current.format("YYYY.MM.DD"));
        current = current.add(1, "day");
    }
    return days;
}

module.exports = new AnalyticsController();
