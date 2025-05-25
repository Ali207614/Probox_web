const { get } = require("lodash");
const tokenService = require('../services/tokenService');
const { v4: uuidv4, validate } = require('uuid');
const path = require('path')
const fs = require('fs')
let dbService = require('../services/dbService')
const DataRepositories = require("../repositories/dataRepositories");
const ApiError = require("../exceptions/api-error");
const InvoiceModel = require("../models/invoice-model");
const CommentModel = require("../models/comment-model")
const b1Sl = require('./b1SL')
const { convertToISOFormat, shuffleArray, checkFileType, parseLocalDateString } = require("../helpers");
const moment = require('moment-timezone')
require('dotenv').config();


class b1HANA {
    execute = async (sql) => {
        try {
            let data = await dbService.execute(sql);
            return data;
        } catch (e) {
            throw new Error(e);
        }
    };

    login = async (req, res, next) => {
        try {
            const { login, password } = req.body;

            if (!login || !password) {
                return next(ApiError.BadRequest('Некорректный login или password'));
            }

            const query = await DataRepositories.getSalesManager({ login, password });
            let user = await this.execute(query);
            if (user.length == 0) {
                return next(ApiError.BadRequest('Пользователь не найден'));
            }

            if (user.length > 1) {
                return next(ApiError.BadRequest('Найдено несколько пользователей с указанными учетными данными. Проверьте введенные данные.'));
            }

            const token = tokenService.generateJwt(user[0]);

            return res.status(201).json({
                token,
                data: {
                    SlpCode: user[0].SlpCode,
                    SlpName: user[0].SlpName,
                    U_role: user[0].U_role
                }
            });
        }
        catch (e) {
            next(e)
        }
    };

    invoice = async (req, res, next) => {
        try {
            let {
                startDate,
                endDate,
                page = 1,
                limit = 20,
                slpCode,
                paymentStatus,
                cardCode,
                serial,
                phone,
                search,
                phoneConfiscated
            } = req.query;

            page = Number(page);
            limit = Number(limit);
            const skip = (page - 1) * limit;

            if (!startDate || !endDate) {
                return res.status(400).json({ error: 'startDate and endDate are required' });
            }

            const now = moment();
            if (!moment(startDate, 'YYYY.MM.DD', true).isValid()) {
                startDate = moment(now).startOf('month').format('YYYY.MM.DD');
            }
            if (!moment(endDate, 'YYYY.MM.DD', true).isValid()) {
                endDate = moment(now).endOf('month').format('YYYY.MM.DD');
            }

            if (search) {
                search = search.replace(/'/g, '');
            }

            const slpCodeRaw = req.query.slpCode;
            const slpCodeArray = slpCodeRaw?.split(',').map(Number).filter(n => !isNaN(n));

            let invoicesModel = [];

            if (slpCode && Array.isArray(slpCodeArray) && slpCodeArray.length > 0) {
                let filter = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                    }
                };

                if (['true', 'false'].includes(phoneConfiscated)) {
                    filter.phoneConfiscated = phoneConfiscated === 'true';
                }

                invoicesModel = await InvoiceModel.find(filter, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    images: 1,
                    newDueDate: 1,
                    CardCode: 1
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();

                if (invoicesModel.length === 0) {
                    return res.status(200).json({ total: 0, page, limit, totalPages: 0, data: [] });
                }

                const query = await DataRepositories.getDistributionInvoice({
                    startDate,
                    endDate,
                    limit,
                    offset: skip,
                    paymentStatus,
                    cardCode,
                    serial,
                    phone,
                    invoices: invoicesModel,
                    search
                });

                const invoices = await this.execute(query);
                const total = get(invoices, '[0].TOTAL', 0) || 0;

                // Map invoiceModel for fast lookup
                const invoiceMap = new Map();
                for (const inv of invoicesModel) {
                    invoiceMap.set(`${inv.DocEntry}_${inv.InstlmntID}`, inv);
                }

                const commentFilter = invoices.map(el => ({
                    DocEntry: el.DocEntry,
                    InstlmntID: el.InstlmntID
                }));

                const comments = await CommentModel.find({ $or: commentFilter }).sort({ created_at: 1 });

                const commentMap = {};
                for (const c of comments) {
                    const key = `${c.DocEntry}_${c.InstlmntID}`;
                    if (!commentMap[key]) commentMap[key] = [];
                    commentMap[key].push(c);
                }

                const data = invoices.map(el => {
                    const key = `${el.DocEntry}_${el.InstlmntID}`;
                    const inv = invoiceMap.get(key);
                    return {
                        ...el,
                        SlpCode: inv?.SlpCode || null,
                        Images: inv?.images || [],
                        NewDueDate: inv?.newDueDate || '',
                        Comments: commentMap[key] || [],
                        phoneConfiscated: inv?.phoneConfiscated || false
                    };
                });

                return res.status(200).json({
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                    data
                });
            }

            // slpCode bo'lmagan holat
            let baseFilter = {
                DueDate: {
                    $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                }
            };
            let invoiceConfiscated = [];

            if (phoneConfiscated === 'true' || phoneConfiscated === 'false') {
                baseFilter.phoneConfiscated = phoneConfiscated === 'true';
                invoiceConfiscated = await InvoiceModel.find(baseFilter, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    images: 1,
                    newDueDate: 1,
                    CardCode: 1
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
                if (invoiceConfiscated.length == 0) {
                    return res.status(200).json({
                        total: 0,
                        page: 0,
                        limit: 0,
                        totalPages: 0,
                        data: []
                    });
                }
            }
            let inInv = []
            let notInv = []
            if (phoneConfiscated === 'true') {
                inInv = invoiceConfiscated
            }
            else if (phoneConfiscated === 'false') {
                notInv = invoiceConfiscated
            }

            const query = await DataRepositories.getInvoice({
                startDate,
                endDate,
                limit,
                offset: skip,
                paymentStatus,
                cardCode,
                serial,
                phone,
                search,
                inInv,
                notInv,
                phoneConfiscated
            });

            const invoices = await this.execute(query);
            const total = get(invoices, '[0].TOTAL', 0) || 0;

            const commentFilter = invoices.map(el => ({
                DocEntry: el.DocEntry,
                InstlmntID: el.InstlmntID
            }));

            const comments = await CommentModel.find({ $or: commentFilter }).sort({ created_at: 1 });

            const commentMap = {};
            for (const c of comments) {
                const key = `${c.DocEntry}_${c.InstlmntID}`;
                if (!commentMap[key]) commentMap[key] = [];
                commentMap[key].push(c);
            }

            const docEntrySet = [...new Set(invoices.map(el => el.DocEntry))];
            invoicesModel = await InvoiceModel.find({
                DocEntry: { $in: docEntrySet }
            });

            const invoiceMap = new Map();
            for (const inv of invoicesModel) {
                invoiceMap.set(`${inv.DocEntry}_${inv.InstlmntID}`, inv);
            }

            const data = invoices.map(el => {
                const key = `${el.DocEntry}_${el.InstlmntID}`;
                const inv = invoiceMap.get(key);
                return {
                    ...el,
                    SlpCode: inv?.SlpCode || null,
                    Images: inv?.images || [],
                    NewDueDate: inv?.newDueDate || '',
                    Comments: commentMap[key] || [],
                    phoneConfiscated: inv?.phoneConfiscated || false
                };
            });


            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data
            });

        } catch (e) {
            next(e);
        }
    };

    search = async (req, res, next) => {
        try {
            let {
                startDate,
                endDate,
                page = 1,
                limit = 50,
                slpCode,
                paymentStatus,
                search,
                phone,
                phoneConfiscated
            } = req.query;

            if (search) {
                search = search.replace(/'/g, '');
            }

            page = parseInt(page, 10);
            limit = parseInt(limit, 10);
            const skip = (page - 1) * limit;

            if (!startDate || !endDate) {
                return res.status(400).json({ error: 'startDate and endDate are required' });
            }

            const now = moment();
            if (!moment(startDate, 'YYYY.MM.DD', true).isValid()) {
                startDate = moment(now).startOf('month').format('YYYY.MM.DD');
            }

            if (!moment(endDate, 'YYYY.MM.DD', true).isValid()) {
                endDate = moment(now).endOf('month').format('YYYY.MM.DD');
            }

            const slpCodeRaw = req.query.slpCode;
            const slpCodeArray = slpCodeRaw?.split(',').map(Number).filter(n => !isNaN(n));

            // 📦 BIRINCHI CASE: slpCode mavjud bo‘lsa
            if (slpCode && Array.isArray(slpCodeArray) && slpCodeArray.length > 0) {
                let filter = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate(),
                    }
                };

                if (['true', 'false'].includes(phoneConfiscated)) {
                    filter.phoneConfiscated = phoneConfiscated === 'true';
                }

                const invoicesModel = await InvoiceModel.find(filter, {
                    DocEntry: 1, InstlmntID: 1, SlpCode: 1, images: 1, newDueDate: 1, CardCode: 1
                })
                    .sort({ DueDate: 1 })
                    .hint({ SlpCode: 1, DueDate: 1 })
                    .lean();

                if (invoicesModel.length === 0) {
                    return res.status(200).json({
                        total: 0,
                        page,
                        limit,
                        totalPages: 0,
                        data: []
                    });
                }

                const query = await DataRepositories.getInvoiceSearchBPorSeriaDistribution({
                    startDate,
                    endDate,
                    limit,
                    offset: skip,
                    paymentStatus,
                    search,
                    phone,
                    invoices: invoicesModel
                });

                const invoices = await this.execute(query);
                const total = get(invoices, '[0].TOTAL', 0) || 0;

                return res.status(200).json({
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                    data: invoices
                });
            }
            let baseFilter = {
                DueDate: {
                    $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                }
            };
            let invoiceConfiscated = [];

            if (phoneConfiscated === 'true' || phoneConfiscated === 'false') {
                baseFilter.phoneConfiscated = phoneConfiscated === 'true';
                invoiceConfiscated = await InvoiceModel.find(baseFilter, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    images: 1,
                    newDueDate: 1,
                    CardCode: 1
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();

                if (invoiceConfiscated.length == 0) {
                    return res.status(200).json({
                        total: 0,
                        page: 0,
                        limit: 0,
                        totalPages: 0,
                        data: []
                    });
                }
            }
            let inInv = []
            let notInv = []
            if (phoneConfiscated === 'true') {
                inInv = invoiceConfiscated
            }
            if (phoneConfiscated === 'false') {
                notInv = invoiceConfiscated
            }

            const query = await DataRepositories.getInvoiceSearchBPorSeria({
                startDate,
                endDate,
                limit,
                offset: skip,
                paymentStatus,
                search,
                phone,
                inInv,
                notInv,
                phoneConfiscated
            });

            const invoices = await this.execute(query);

            const docEntrySet = [...new Set(invoices.map(el => el.DocEntry))];
            const invoicesModel = await InvoiceModel.find({
                DocEntry: { $in: docEntrySet }
            });

            const slpCodeMap = new Map();
            for (const item of invoicesModel) {
                slpCodeMap.set(`${item.DocEntry}_${item.InstlmntID}`, item.SlpCode);
            }

            const total = get(invoices, '[0].TOTAL', 0) || 0;

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data: invoices.map(el => ({
                    ...el,
                    SlpCode: slpCodeMap.get(`${el.DocEntry}_${el.InstlmntID}`) || null
                }))
            });

        } catch (e) {
            next(e);
        }
    };

    executors = async (req, res, next) => {
        try {
            const query = await DataRepositories.getSalesPersons();
            let data = await this.execute(query);
            let total = data.length

            return res.status(200).json({
                total,
                data: data.sort((a, b) => b.SlpName.localeCompare(a.SlpName))
            });
        }
        catch (e) {
            next(e)
        }
    };

    distribution = async (req, res, next) => {
        try {
            let { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                return res.status(404).json({ error: 'startDate and endDate are required' });
            }

            const executorsQuery = await DataRepositories.getSalesPersons();
            let executorList = await this.execute(executorsQuery);

            let SalesList = executorList.filter(el => el.U_role == 'Assistant')

            const query = await DataRepositories.getDistribution({ startDate, endDate })
            let data = await this.execute(query)
            let docEntries = [...new Set(data.map(el => el.DocEntry))]
            const invoices = await InvoiceModel.find({ DocEntry: { $in: docEntries } });
            let newResult = []
            let count = 0
            for (let i = 0; i < data.length; i++) {
                let existInvoice = invoices.filter(el => el.DocEntry == data[i].DocEntry)
                if (existInvoice?.length) {
                    let existShuffle = existInvoice.find(el => el.InstlmntID == data[i].InstlmntID)
                    if (!existShuffle) {
                        let nonExistList = shuffleArray(SalesList.filter(item => !existInvoice.map(item => item.SlpCode).includes(item.SlpCode)))
                        let first = nonExistList.length ? nonExistList[0] : shuffleArray(SalesList)[0]
                        newResult.push({
                            DueDate: parseLocalDateString(moment(data[i].DueDate).format('YYYY.MM.DD')),
                            SlpName: first.SlpName,
                            InstlmntID: data[i].InstlmntID,
                            DocEntry: data[i].DocEntry,
                            SlpCode: first.SlpCode,
                            CardCode: data[i].CardCode,
                            ItemName: data[i].Dscription
                        })
                    }
                }
                else {
                    let first = SalesList[count]

                    newResult.push({
                        DueDate: parseLocalDateString(moment(data[i].DueDate).format('YYYY.MM.DD')),
                        SlpName: first?.SlpName,
                        InstlmntID: data[i].InstlmntID,
                        DocEntry: data[i].DocEntry,
                        SlpCode: first?.SlpCode,
                        CardCode: data[i].CardCode,
                        ItemName: data[i].Dscription
                    })
                }
                count = (count == (SalesList.length - 1)) ? 0 : count += 1
            }
            await InvoiceModel.create(newResult)
            return res.status(200).json({ message: 'success' });
        }
        catch (e) {
            next(e)
        }
    };

    getRate = async (req, res, next) => {
        const query = await DataRepositories.getRate(req.query)
        let data = await this.execute(query)
        return res.status(200).json(data[0] || {})
    }

    getPayList = async (req, res, next) => {
        try {
            const { id } = req.params
            const query = await DataRepositories.getPayList({ docEntry: id })

            let data = await this.execute(query)
            let InstIdList = [...new Set(data.map(el => el.InstlmntID))]
            let result = InstIdList.map(el => {
                let list = data.filter(item => item.InstlmntID == el)

                return {
                    DueDate: get(list, `[0].DueDate`, 0),
                    InstlmntID: el,
                    PaidToDate: list?.length ? list.filter(item => (item.Canceled === null || item.Canceled === 'N')).reduce((a, b) => a + Number(b?.SumApplied || 0), 0) : 0,
                    InsTotal: get(list, `[0].InsTotal`, 0),
                    PaysList: list.filter(i => i.DocDate && (i.Canceled === null || i.Canceled === 'N')).map(item => ({
                        SumApplied: item.SumApplied,
                        AcctName: item.AcctName,
                        DocDate: item.DocDate,
                        CashAcct: item.CashAcct,
                        CheckAcct: item.CheckAcct,
                        Canceled: item.Canceled
                    }))
                }
            })
            return res.status(200).json(result)
        }
        catch (e) {
            next(e)
        }
    }

    getAnalytics = async (req, res, next) => {
        try {

            let { startDate, endDate, slpCode, phoneConfiscated } = req.query

            if (!startDate || !endDate) {
                return res.status(404).json({ error: 'startDate and endDate are required' });
            }

            const now = moment();

            if (!moment(startDate, 'YYYY.MM.DD', true).isValid()) {
                startDate = moment(now).startOf('month').format('YYYY.MM.DD');
            }

            if (!moment(endDate, 'YYYY.MM.DD', true).isValid()) {
                endDate = moment(now).endOf('month').format('YYYY.MM.DD');
            }

            const slpCodeRaw = req.query.slpCode; // "1,4,5"
            const slpCodeArray = slpCodeRaw?.split(',').map(Number).filter(n => !isNaN(n));
            const tz = 'Asia/Tashkent'
            if (slpCode && Array.isArray(slpCodeArray) && slpCodeArray.length > 0) {
                let filter = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate(),
                    }
                };

                let invoicesModel = await InvoiceModel.find(filter, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    images: 1,
                    newDueDate: 1,
                    CardCode: 1,
                    InsTotal: 1
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
                if (invoicesModel.length === 0) {
                    return res.status(200).json({
                        SumApplied: 0,
                        InsTotal: 0,
                        PaidToDate: 0
                    });
                }
                let phoneConfisList = invoicesModel.filter(item => !item?.phoneConfiscated)
                let confiscatedTotal = invoicesModel.filter(item => item?.phoneConfiscated)?.reduce((a, b) => a + Number(b?.InsTotal || 0), 0) || 0

                if (phoneConfisList.length === 0) {
                    let obj = {
                        SumApplied: confiscatedTotal,
                        InsTotal: confiscatedTotal,
                        PaidToDate: confiscatedTotal
                    };
                    return res.status(200).json(obj);
                }

                const query = await DataRepositories.getAnalytics({
                    startDate,
                    endDate,
                    invoices: phoneConfisList,
                    phoneConfiscated: 'false'
                });
                let data = await this.execute(query);
                const result = data.length ? data[0] : {
                    SumApplied: 0,
                    InsTotal: 0,
                    PaidToDate: 0
                };
                result.SumApplied = Number(result.SumApplied) + confiscatedTotal;
                result.InsTotal = Number(result.InsTotal) + confiscatedTotal;
                result.PaidToDate = Number(result.PaidToDate) + confiscatedTotal;

                return res.status(200).json(result);
            }

            let baseFilter = {
                DueDate: {
                    $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                }
            };
            let invoiceConfiscated = [];

            baseFilter.phoneConfiscated = true;
            invoiceConfiscated = await InvoiceModel.find(baseFilter, {
                phoneConfiscated: 1,
                DocEntry: 1,
                InstlmntID: 1,
                SlpCode: 1,
                images: 1,
                newDueDate: 1,
                CardCode: 1,
                InsTotal: 1
            }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();


            let confiscatedTotal = invoiceConfiscated.length ? invoiceConfiscated.reduce((a, b) => a + Number(b?.InsTotal || 0), 0) : 0
            const query = await DataRepositories.getAnalytics({ startDate, endDate, invoices: invoiceConfiscated, phoneConfiscated: 'true' })

            let data = await this.execute(query)
            let result = data.length ? {
                SumApplied: Number(data[0].SumApplied ?? 0),
                InsTotal: Number(data[0].InsTotal ?? 0),
                PaidToDate: Number(data[0].PaidToDate ?? 0),
            } : {
                SumApplied: 0,
                InsTotal: 0,
                PaidToDate: 0
            };

            result.SumApplied += confiscatedTotal;
            result.InsTotal += confiscatedTotal;
            result.PaidToDate += confiscatedTotal;

            return res.status(200).json(result);
        }
        catch (e) {
            next(e)
        }
    }

    getAnalyticsByDay = async (req, res, next) => {
        try {

            let { startDate, endDate, slpCode, phoneConfiscated } = req.query

            if (!startDate || !endDate) {
                return res.status(404).json({ error: 'startDate and endDate are required' });
            }

            const now = moment();

            if (!moment(startDate, 'YYYY.MM.DD', true).isValid()) {
                startDate = moment(now).startOf('month').format('YYYY.MM.DD');
            }

            if (!moment(endDate, 'YYYY.MM.DD', true).isValid()) {
                endDate = moment(now).endOf('month').format('YYYY.MM.DD');
            }

            const slpCodeRaw = req.query.slpCode; // "1,4,5"
            const slpCodeArray = slpCodeRaw?.split(',').map(Number).filter(n => !isNaN(n));
            const tz = 'Asia/Tashkent'
            if (slpCode && Array.isArray(slpCodeArray) && slpCodeArray.length > 0) {
                let filter = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate(),
                    }
                };

                let invoicesModel = await InvoiceModel.find(filter, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    images: 1,
                    newDueDate: 1,
                    CardCode: 1,
                    InsTotal: 1
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
                if (invoicesModel.length === 0) {
                    return res.status(200).json([]);
                }
                let phoneConfisList = invoicesModel.filter(item => !item?.phoneConfiscated)
                let confiscatedTotal = invoicesModel.filter(item => item?.phoneConfiscated)?.reduce((a, b) => a + Number(b?.InsTotal || 0), 0) || 0

                if (phoneConfisList.length === 0) {

                    return res.status(200).json([]);
                }

                const query = await DataRepositories.getAnalyticsByDay({
                    startDate,
                    endDate,
                    invoices: phoneConfisList,
                    phoneConfiscated: 'false'
                });
                let data = await this.execute(query);
                const result = data;
                // result.SumApplied = Number(result.SumApplied) + confiscatedTotal;
                // result.InsTotal = Number(result.InsTotal) + confiscatedTotal;
                // result.PaidToDate = Number(result.PaidToDate) + confiscatedTotal;

                return res.status(200).json(result);
            }

            let baseFilter = {
                DueDate: {
                    $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                }
            };
            let invoiceConfiscated = [];

            baseFilter.phoneConfiscated = true;
            invoiceConfiscated = await InvoiceModel.find(baseFilter, {
                phoneConfiscated: 1,
                DocEntry: 1,
                InstlmntID: 1,
                SlpCode: 1,
                images: 1,
                newDueDate: 1,
                CardCode: 1,
                InsTotal: 1
            }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();


            let confiscatedTotal = invoiceConfiscated.length ? invoiceConfiscated.reduce((a, b) => a + Number(b?.InsTotal || 0), 0) : 0

            const query = await DataRepositories.getAnalyticsByDay({ startDate, endDate, invoices: invoiceConfiscated, phoneConfiscated: 'true' })
            let data = await this.execute(query)
            let result = data;


            // result.SumApplied += confiscatedTotal;
            // result.InsTotal += confiscatedTotal;
            // result.PaidToDate += confiscatedTotal;

            return res.status(200).json(result);
        }
        catch (e) {
            next(e)
        }
    }

    createComment = async (req, res, next) => {
        try {
            const { Comments } = req.body;
            const { DocEntry, InstlmntID } = req.params
            const { SlpCode } = req.user;
            if (!Comments || Comments.length == 0) {
                return res.status(400).json({
                    message: 'Comment not found',
                });
            }
            if (Comments.length > 300) {
                return res.status(400).json({
                    message: 'Comment long',
                });
            }
            const newComment = new CommentModel({
                DocEntry,
                InstlmntID,
                Comments,
                SlpCode,
                DocDate: new Date()
            });

            await newComment.save();

            return res.status(201).json({
                message: 'Comment created successfully',
                data: newComment
            });
        } catch (e) {
            next(e);
        }
    };

    getComments = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID } = req.params;

            const filter = {};
            if (DocEntry) filter.DocEntry = DocEntry;

            const comments = await CommentModel.find(filter).sort({ created_at: 1 });

            return res.status(200).json(comments);
        } catch (e) {
            next(e);
        }
    };

    updateComment = async (req, res, next) => {
        try {
            const { id } = req.params;
            const { Comments } = req.body;

            if (!Comments || Comments.length == 0) {
                return res.status(400).json({
                    message: 'Comment not found',
                });
            }
            if (Comments.length > 300) {
                return res.status(400).json({
                    message: 'Comment long',
                });
            }
            const updated = await CommentModel.findByIdAndUpdate(
                id,
                { Comments, updatedAt: new Date() },
                { new: true }
            );

            if (!updated) {
                return res.status(404).json({ message: 'Comment not found' });
            }

            return res.status(200).json({
                message: 'Comment updated successfully',
                data: updated
            });
        } catch (e) {
            next(e);
        }
    };

    deleteComment = async (req, res, next) => {
        try {
            const { id } = req.params;

            const deleted = await CommentModel.findByIdAndDelete(id);

            if (!deleted) {
                return res.status(404).json({ message: 'Comment not found' });
            }

            return res.status(200).json({
                message: 'Comment deleted successfully'
            });
        } catch (e) {
            next(e);
        }
    };

    uploadImage = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID } = req.params;
            const files = req.files;

            if (!files || files.length === 0) {
                return res.status(400).send('Error: No files uploaded.');
            }

            const imageEntries = files.map(file => ({
                _id: uuidv4(),
                image: file.filename // multer filename avtomatik qaytadi
            }));

            let invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (invoice) {
                if (!Array.isArray(invoice.images)) {
                    invoice.images = [];
                }
                invoice.images.push(...imageEntries);
                await invoice.save();
            } else {
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    images: imageEntries
                });
            }

            return res.status(201).send({
                images: imageEntries.map(e => ({
                    _id: e._id,
                    image: e.image
                })),
                DocEntry,
                InstlmntID
            });
        } catch (e) {
            next(e);
        }
    };

    deleteImage = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID, ImageId } = req.params;
            const invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });
            if (!invoice) return res.status(404).send('Invoice not found');

            const image = invoice.images.find(img => String(img._id) === String(ImageId));
            if (!image) return res.status(404).send('Image not found');

            // Fayl nomini ajratib olamiz
            const imageFileName = image.image;

            // DB'dan rasmni o‘chiramiz
            await InvoiceModel.updateOne(
                { DocEntry, InstlmntID },
                { $pull: { images: { _id: ImageId } } }
            );

            // Fayl tizimidan ham o‘chiramiz
            const filePath = path.join(process.cwd(), 'uploads', imageFileName);
            fs.unlink(filePath, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error('File deletion error:', err);
                }
            });

            return res.status(200).send({
                message: 'Image deleted successfully',
                imageId: ImageId,
                fileName: imageFileName
            });
        } catch (e) {
            next(e);
        }
    };

    updateExecutor = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID } = req.params;
            const { slpCode, DueDate, newDueDate = '', Phone1, Phone2, CardCode = '' } = req.body;
            if (!DueDate) {
                return res.status(400).send({
                    message: "Missing required fields: slpCode and/or DueDate and/or newDueDate"
                });
            }

            let invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (invoice) {
                if (slpCode) {
                    invoice.SlpCode = slpCode;
                }

                if (newDueDate) {
                    const parsedDate = parseLocalDateString(newDueDate);
                    invoice.newDueDate = parsedDate;
                }

                await invoice.save();
            } else {
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    SlpCode: (slpCode || ''),
                    newDueDate: newDueDate ? parseLocalDateString(newDueDate) : '',
                    DueDate: parseLocalDateString(DueDate)
                });
            }

            if (CardCode && (Phone1 || Phone2)) {
                let data = await b1Sl.updateBusinessPartner({ Phone1, Phone2, CardCode })
                if (data) {
                    return res.status(200).send({
                        message: invoice ? "Invoice updated successfully." : "Invoice created successfully.",
                        Phone1,
                        Phone2,
                        CardCode,
                        DueDate,
                        newDueDate
                    });
                }
            }


            return res.status(200).send({
                message: invoice ? "Invoice updated successfully." : "Invoice created successfully.",
                DocEntry,
                InstlmntID,
                slpCode,
                _id: invoice._id,
            });
        } catch (e) {
            next(e);
        }
    };

    confiscating = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID } = req.params;
            const { phoneConfiscated, DueDate } = req.body;

            if (!DueDate) {
                return res.status(400).send({
                    message: "Missing required fields: DueDate "
                });
            }

            let invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (invoice) {
                const query = await DataRepositories.getInvoiceById({ DocEntry, InstlmntID })
                let data = await this.execute(query)
                invoice.phoneConfiscated = phoneConfiscated ? true : false;
                invoice.InsTotal = data.length ? Number(data[0]?.InsTotal || 0) : 0
                await invoice.save();

            } else {
                const query = await DataRepositories.getInvoiceById({ DocEntry, InstlmntID })
                let data = await this.execute(query)
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    DueDate: parseLocalDateString(DueDate),
                    phoneConfiscated: phoneConfiscated ? true : false,
                    InsTotal: (data.length ? Number(data[0]?.InsTotal || 0) : 0)
                });
            }

            return res.status(200).send({
                message: invoice ? "Invoice updated successfully." : "Invoice created successfully.",
                DocEntry,
                InstlmntID,
                phoneConfiscated: invoice.phoneConfiscated,
                _id: invoice._id,
            });
        } catch (e) {
            next(e);
        }
    };
}

module.exports = new b1HANA();


