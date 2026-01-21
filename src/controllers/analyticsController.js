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
