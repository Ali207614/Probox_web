const { get } = require("lodash");
const tokenService = require('../services/tokenService');
const { v4: uuidv4 } = require('uuid');
const path = require('path')
const fs = require('fs')
let dbService = require('../services/dbService')
const DataRepositories = require("../repositories/dataRepositories");
const ApiError = require("../exceptions/api-error");
const InvoiceModel = require("../models/invoice-model");
const CommentModel = require("../models/comment-model")
const UserModel = require("../models/user-model")
const b1Sl = require('./b1SL')
const { convertToISOFormat, shuffleArray, checkFileType, parseLocalDateString } = require("../helpers");
const moment = require('moment-timezone')
const sharp = require('sharp');
const fsPromises = require('fs/promises');
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
            return next(ApiError.UnauthorizedError());
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
                search = search.replace(/'/g, "''"); // SQL injectionni oldini oladi
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
                let filterPartial = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                    }
                };

                if (phoneConfiscated === 'true') {
                    filter.phoneConfiscated = true;
                } else if (['false'].includes(phoneConfiscated)) {
                    filter.$or = [
                        { phoneConfiscated: false },
                        { phoneConfiscated: { $exists: false } }
                    ];
                }

                if (paymentStatus.split(',').includes('paid') || paymentStatus.split(',').includes('partial')) {
                    filterPartial.partial = true
                }

                let partialModel = []

                if (get(filterPartial, 'partial')) {
                    partialModel = await InvoiceModel.find(filterPartial, {
                        phoneConfiscated: 1,
                        DocEntry: 1,
                        InstlmntID: 1,
                        SlpCode: 1,
                        images: 1,
                        newDueDate: 1,
                        CardCode: 1
                    }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
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
                    partial: partialModel,
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

                let userModel = await UserModel.find({
                    CardCode: { $in: invoices.map(el => el.CardCode) }
                });

                const userLocationMap = new Map();
                userModel.forEach(user => {
                    if (user.CardCode) {
                        userLocationMap.set(user.CardCode, {
                            Lat: user.Lat || null,
                            Long: user.Long || null,
                        });
                    }
                });

                const data = invoices.map(el => {
                    const key = `${el.DocEntry}_${el.InstlmntID}`;
                    const inv = invoiceMap.get(key);
                    const userLocation = userLocationMap.get(el.CardCode) || {};

                    return {
                        ...el,
                        SlpCode: inv?.SlpCode || null,
                        Images: inv?.images || [],
                        NewDueDate: inv?.newDueDate || '',
                        Comments: commentMap[key] || [],
                        phoneConfiscated: inv?.phoneConfiscated || false,
                        partial: partialModel.find(item => `${item.DocEntry}_${item.InstlmntID}` === key)?.partial === true,
                        Lat: userLocation.Lat || null,
                        Long: userLocation.Long || null,
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

            let baseFilterPartial = {
                DueDate: {
                    $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                }
            };
            let invoiceConfiscated = [];

            if (phoneConfiscated === 'true' || phoneConfiscated === 'false') {
                baseFilter.phoneConfiscated = true;
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

            if (paymentStatus.split(',').includes('paid') || paymentStatus.split(',').includes('partial')) {
                baseFilterPartial.partial = true
            }

            let partialModel = []

            if (get(baseFilterPartial, 'partial')) {
                partialModel = await InvoiceModel.find(baseFilterPartial, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    images: 1,
                    newDueDate: 1,
                    CardCode: 1
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
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
                phoneConfiscated,
                partial: partialModel
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

            let userModel = await UserModel.find({
                CardCode: { $in: invoices.map(el => el.CardCode) }
            });

            const userLocationMap = new Map();
            userModel.forEach(user => {
                if (user.CardCode) {
                    userLocationMap.set(user.CardCode, {
                        Lat: user.Lat || null,
                        Long: user.Long || null,
                    });
                }
            });

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
                const userLocation = userLocationMap.get(el.CardCode) || {};

                return {
                    ...el,
                    SlpCode: inv?.SlpCode || null,
                    Images: inv?.images || [],
                    NewDueDate: inv?.newDueDate || '',
                    Comments: commentMap[key] || [],
                    phoneConfiscated: inv?.phoneConfiscated || false,
                    partial: partialModel.find(item => `${item.DocEntry}_${item.InstlmntID}` === `${el.DocEntry}_${el.InstlmntID}`)?.partial === true
                    Lat: userLocation.Lat || null,
                    Long: userLocation.Long || null,
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
                search = search.replace(/'/g, "''"); // SQL injectionni oldini oladi
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

                let filterPartial = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                    }
                };


                if (phoneConfiscated === 'true') {
                    filter.phoneConfiscated = true;
                } else if (['false'].includes(phoneConfiscated)) {
                    filter.$or = [
                        { phoneConfiscated: false },
                        { phoneConfiscated: { $exists: false } }
                    ];
                }

                if (paymentStatus.split(',').includes('paid') || paymentStatus.split(',').includes('partial')) {
                    filterPartial.partial = true
                }

                let partialModel = []

                if (get(filterPartial, 'partial')) {
                    partialModel = await InvoiceModel.find(filterPartial, {
                        phoneConfiscated: 1,
                        DocEntry: 1,
                        InstlmntID: 1,
                        SlpCode: 1,
                        images: 1,
                        newDueDate: 1,
                        CardCode: 1
                    }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
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
                    invoices: invoicesModel,
                    partial: partialModel,
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

            let baseFilterPartial = {
                DueDate: {
                    $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate()
                }
            };

            let invoiceConfiscated = [];

            if (phoneConfiscated === 'true' || phoneConfiscated === 'false') {
                baseFilter.phoneConfiscated = true;
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



            if (paymentStatus.split(',').includes('paid') || paymentStatus.split(',').includes('partial')) {
                baseFilterPartial.partial = true
            }

            let partialModel = []

            if (get(baseFilterPartial, 'partial')) {
                partialModel = await InvoiceModel.find(baseFilterPartial, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    images: 1,
                    newDueDate: 1,
                    CardCode: 1
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
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
                phoneConfiscated,
                partial: partialModel
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
            let invoice = await InvoiceModel.find({ DocEntry: id })
            let data = await this.execute(query)
            let InstIdList = [...new Set(data.map(el => el.InstlmntID))]
            let result = InstIdList.map(el => {
                let list = data.filter(item => item.InstlmntID == el)
                let invoiceItem = invoice.find(item => item.InstlmntID == el)
                console.log(invoiceItem)
                return {
                    ItemCode: get(list, `[0].ItemCode`, ''),
                    Dscription: get(list, `[0].Dscription`, ''),
                    CardCode: get(list, `[0].CardCode`, ''),
                    CardName: get(list, `[0].CardName`, ''),
                    MaxDocTotal: get(list, `[0].MaxDocTotal`, 0),
                    MaxTotalPaidToDate: get(list, `[0].MaxTotalPaidToDate`, 0),
                    Cellular: get(list, `[0].Cellular`, ''),
                    Phone1: get(list, `[0].Phone1`, ''),
                    Phone2: get(list, `[0].Phone2`, ''),
                    InstlmntID: el,
                    PaidToDate: list?.length ? list.filter(item => (item.Canceled === null || item.Canceled === 'N')).reduce((a, b) => a + Number(b?.SumApplied || 0), 0) : 0,
                    InsTotal: get(list, `[0].InsTotal`, 0),
                    Images: invoiceItem?.images || [],
                    partial: invoiceItem?.partial || false,
                    phoneConfiscated: invoiceItem?.phoneConfiscated || false,
                    SlpCode: invoiceItem?.SlpCode || null,
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
                // if (phoneConfiscated === 'true') {
                //     filter.phoneConfiscated = true;
                // } else if (['false'].includes(phoneConfiscated)) {
                //     filter.$or = [
                //         { phoneConfiscated: false },
                //         { phoneConfiscated: { $exists: false } }
                //     ];
                // }

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
                    // phoneConfiscated: 'false'
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
                // if (phoneConfiscated === 'true') {
                // filter.phoneConfiscated = true;
                // } else if (['false'].includes(phoneConfiscated)) {
                //     filter.$or = [
                //         { phoneConfiscated: false },
                //         { phoneConfiscated: { $exists: false } }
                //     ];
                // }

                let invoicesModel = await InvoiceModel.find(filter, {
                    phoneConfiscated: 1,
                    DocEntry: 1,
                    InstlmntID: 1,
                    SlpCode: 1,
                    DueDate: 1,
                    InsTotal: 1,
                    CardCode: 1,
                }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();
                if (invoicesModel.length === 0) {
                    return res.status(200).json([]);
                }

                let phoneConfisList = invoicesModel.filter(item => !item?.phoneConfiscated)
                let confiscatedTotal = invoicesModel.filter(item => item?.phoneConfiscated)

                if (phoneConfisList.length === 0) {
                    return res.status(200).json([]);
                }


                const query = await DataRepositories.getAnalyticsByDay({
                    startDate,
                    endDate,
                    invoices: phoneConfisList,
                });
                let data = await this.execute(query);
                if (phoneConfisList.length === 0 || data.length === 0) {
                    return res.status(200).json(data);
                }
                data.forEach(item => {
                    const formattedDate = item.DueDate; // '2025.05.01'

                    const matchingInvoices = confiscatedTotal.filter(inv => {
                        const invFormattedDate = moment.utc(inv.DueDate).format('YYYY.MM.DD');
                        return invFormattedDate == formattedDate;
                    });
                    if (matchingInvoices.length > 0) {
                        let sum = matchingInvoices.reduce((sum, inv) => sum + Number(inv?.InsTotal,), 0) || 0;
                        item.PhoneConfiscated = true;
                        item.Confiscated = sum;


                        item.SumApplied = Number(item.SumApplied) + sum;
                        item.InsTotal = Number(item.InsTotal) + sum;
                        item.PaidToDate = Number(item.PaidToDate) + sum;
                    }
                    else {
                        item.PhoneConfiscated = false;
                        item.Confiscated = 0
                    }
                });

                return res.status(200).json(data);
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
                CardCode: 1,
                InsTotal: 1,
                DueDate: 1
            }).sort({ DueDate: 1 }).hint({ SlpCode: 1, DueDate: 1 }).lean();

            const query = await DataRepositories.getAnalyticsByDay({ startDate, endDate, invoices: invoiceConfiscated, phoneConfiscated: 'true' })
            let data = await this.execute(query)


            data.forEach(item => {
                const formattedDate = item.DueDate; // '2025.05.01'

                const matchingInvoices = invoiceConfiscated.filter(inv => {
                    const invFormattedDate = moment.utc(inv.DueDate).format('YYYY.MM.DD'); // UTC asosida, timezone qo‘shilmaydi
                    return invFormattedDate === formattedDate;
                });


                if (matchingInvoices.length > 0) {
                    let sum = matchingInvoices.reduce((sum, inv) => sum + Number(inv.InsTotal), 0) || 0;
                    item.PhoneConfiscated = true;
                    item.Confiscated = sum

                    item.SumApplied = Number(item.SumApplied) + sum;
                    item.InsTotal = Number(item.InsTotal) + sum;
                    item.PaidToDate = Number(item.PaidToDate) + sum;
                }
                else {
                    item.PhoneConfiscated = false;
                    item.Confiscated = 0
                }
            });


            return res.status(200).json(data);
        }
        catch (e) {
            next(e)
        }
    }

    getAnalyticsBySlpCode = async (req, res, next) => {
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
                let confiscatedTotal = invoicesModel.filter(item => item?.phoneConfiscated)

                if (phoneConfisList.length === 0) {
                    return res.status(200).json([]);
                }

                const query = await DataRepositories.getAnalyticsBySlpCode({
                    startDate,
                    endDate,
                    invoices: phoneConfisList,
                });
                let data = await this.execute(query);

                const invoiceKeyMap = new Map();
                for (const { SlpCode, DocEntry, InstlmntID } of invoicesModel) {
                    const key = `${DocEntry}_${InstlmntID}`;
                    if (!invoiceKeyMap.has(SlpCode)) {
                        invoiceKeyMap.set(SlpCode, new Set());
                    }
                    invoiceKeyMap.get(SlpCode).add(key);
                }

                let result = Array.from(invoiceKeyMap.entries()).map(([slpCode, keySet]) => {
                    const totals = {
                        SlpCode: slpCode,
                        SumApplied: 0,
                        InsTotal: 0,
                        PaidToDate: 0,
                        phoneConfiscated: false,
                        Confiscated: 0
                    };

                    for (const item of data) {
                        const key = `${item.DocEntry}_${item.InstlmntID}`;
                        if (keySet.has(key)) {
                            totals.SumApplied += Number(item?.SumApplied ?? 0);
                            totals.InsTotal += Number(item?.InsTotal ?? 0);
                            totals.PaidToDate += Number(item?.PaidToDate ?? 0);
                        }
                    }

                    return totals;
                });
                if (confiscatedTotal.length) {
                    result = result.map(item => {
                        let confisCatedList = confiscatedTotal.filter(el => el.SlpCode == item.SlpCode)
                        let Confiscated = 0;
                        let phoneConfiscated = false
                        if (confisCatedList.length) {
                            Confiscated = confisCatedList.reduce((a, b) => a + Number(b?.InsTotal || 0), 0) || 0
                            phoneConfiscated = true
                        }
                        item.SumApplied = Number(item.SumApplied) + Confiscated;
                        item.InsTotal = Number(item.InsTotal) + Confiscated;
                        item.PaidToDate = Number(item.PaidToDate) + Confiscated;
                        return { ...item, Confiscated, phoneConfiscated }
                    })
                }

                return res.status(200).json(result);
            }

            let filter = {
                DueDate: {
                    $gte: moment.tz(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment.tz(endDate, 'YYYY.MM.DD').endOf('day').toDate(),
                },
                phoneConfiscated: true
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

            const query = await DataRepositories.getAnalyticsBySlpCode({
                startDate,
                endDate,
                invoices: invoicesModel,
                phoneConfiscated: 'true'
            });
            let data = await this.execute(query);
            if (data.length) {

                let result = data.reduce((a, b) => {
                    a.SumApplied += Number(b?.SumApplied || 0)
                    a.InsTotal += Number(b?.InsTotal || 0)
                    a.PaidToDate += Number(b?.PaidToDate || 0)
                    if (invoicesModel.length) {
                        let sum = invoicesModel.reduce((acc, item) => acc + Number(item?.InsTotal || 0), 0);
                        a.phoneConfiscated = true
                        a.Confiscated = sum
                    }
                    return a
                }, {
                    SlpCode: null,
                    SumApplied: 0,
                    InsTotal: 0,
                    PaidToDate: 0,
                    phoneConfiscated: false,
                    Confiscated: 0
                })
                result = {
                    ...result,
                    SumApplied: result.SumApplied + result.Confiscated,
                    PaidToDate: result.PaidToDate + result.Confiscated,
                    InsTotal: result.InsTotal + result.Confiscated,
                }

                return res.status(200).json([result]);
            }
            return res.status(200).json([]);
        }
        catch (e) {
            next(e)
        }
    }

    createComment = async (req, res, next) => {
        try {
            const { Comments } = req.body;
            const { DocEntry, InstlmntID } = req.params;
            const { SlpCode } = req.user;
            const files = req.files;

            if (!DocEntry && !InstlmntID && !files?.audio) {
                return res.status(400).json({ message: 'DocEntry or InstlmnID is required' });
            }

            const hasComment = !!Comments;
            const hasImage = files?.image?.length > 0;
            const hasAudio = files?.audio?.length > 0;

            const activeInputs = [hasComment, hasImage, hasAudio].filter(Boolean);

            if (activeInputs.length === 0) {
                return res.status(400).json({ message: 'Comment, image, or audio is required' });
            }

            if (activeInputs.length > 1) {
                return res.status(400).json({ message: 'Only one of comment, image, or audio can be submitted at a time' });
            }

            if (Comments && Comments.length > 300) {
                return res.status(400).json({ message: 'Comment too long' });
            }

            let imagePath, audioPath;

            if (hasImage) {
                const originalFilename = files.image[0].filename;
                const originalPath = files.image[0].path;
                const compressedFilename = originalFilename.replace(/\.(jpeg|jpg|png)$/, '_compressed.webp');
                const compressedPath = path.join(path.dirname(originalPath), compressedFilename);

                await sharp(originalPath)
                    .webp({ quality: 70 })
                    .toFile(compressedPath);

                await fsPromises.unlink(originalPath);
                imagePath = compressedFilename;
            }

            if (hasAudio) {
                audioPath = files.audio[0].filename; // faqat nomi
            }

            const newComment = new CommentModel({
                DocEntry,
                InstlmntID,
                Comments: hasComment ? Comments : null,
                SlpCode,
                DocDate: new Date(),
                Image: imagePath || null,
                Audio: audioPath || null
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
            const files = req.files;

            const existing = await CommentModel.findById(id);
            if (!existing) {
                return res.status(404).json({ message: 'Comment not found' });
            }

            const hasComment = !!Comments;
            const hasImage = files?.image?.length > 0;
            const hasAudio = files?.audio?.length > 0;
            const activeInputs = [hasComment, hasImage, hasAudio].filter(Boolean);

            if (activeInputs.length === 0) {
                return res.status(400).json({ message: 'No data to update' });
            }

            if (activeInputs.length > 1) {
                return res.status(400).json({ message: 'Only one of comment, image, or audio can be updated at a time' });
            }

            if (hasComment && Comments.length > 300) {
                return res.status(400).json({ message: 'Comment too long' });
            }

            const updatePayload = {};
            const uploadsDir = path.join(process.cwd(), 'uploads');

            if (hasComment) {
                updatePayload.Comments = Comments;
                updatePayload.Image = null;
                updatePayload.Audio = null;

                // Eski fayllarni o‘chirish
                if (existing.Image) {
                    await fsPromises.unlink(path.join(uploadsDir, existing.Image)).catch(() => {});
                }
                if (existing.Audio) {
                    await fsPromises.unlink(path.join(uploadsDir, existing.Audio)).catch(() => {});
                }
            }

            if (hasImage) {
                const file = files.image[0];
                const ext = path.extname(file.filename);
                const baseName = path.basename(file.filename, ext);
                const compressedName = `${baseName}_compressed.webp`;
                const compressedPath = path.join(file.destination, compressedName);

                await sharp(file.path)
                    .resize({ width: 1024 })
                    .webp({ quality: 70 })
                    .toFile(compressedPath);

                await fsPromises.unlink(file.path);

                // Eski fayllarni o‘chirish
                if (existing.Image) {
                    await fsPromises.unlink(path.join(file.destination, existing.Image)).catch(() => {});
                }
                if (existing.Audio) {
                    await fsPromises.unlink(path.join(file.destination, existing.Audio)).catch(() => {});
                }

                updatePayload.Image = compressedName;
                updatePayload.Audio = null;
                updatePayload.Comments = null;
            }

            if (hasAudio) {
                const file = files.audio[0];

                if (existing.Audio) {
                    await fsPromises.unlink(path.join(file.destination, existing.Audio)).catch(() => {});
                }
                if (existing.Image) {
                    await fsPromises.unlink(path.join(file.destination, existing.Image)).catch(() => {});
                }

                updatePayload.Audio = file.filename;
                updatePayload.Image = null;
                updatePayload.Comments = null;
            }

            updatePayload.updatedAt = new Date();

            const updated = await CommentModel.findByIdAndUpdate(id, updatePayload, { new: true });

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

            const compressedImageEntries = [];

            for (const file of files) {
                const ext = path.extname(file.filename);
                const filenameWithoutExt = path.basename(file.filename, ext);
                const compressedFileName = `${filenameWithoutExt}_compressed.webp`;
                const compressedFilePath = path.join(file.destination, compressedFileName);

                await sharp(file.path)
                    .resize({ width: 1024 }) // optional: resize to max width
                    .webp({ quality: 70 })   // convert and compress
                    .toFile(compressedFilePath);

                // remove original
                await fsPromises.unlink(file.path);

                compressedImageEntries.push({
                    _id: uuidv4(),
                    image: compressedFileName
                });
            }

            let invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (invoice) {
                if (!Array.isArray(invoice.images)) {
                    invoice.images = [];
                }
                invoice.images.push(...compressedImageEntries);
                await invoice.save();
            } else {
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    images: compressedImageEntries
                });
            }

            return res.status(201).send({
                images: compressedImageEntries.map(e => ({
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

    map = async (req, res, next) => {
        try {
            const { cardCode } = req.params;
            const { lat, long } = req.body;

            if (!cardCode || !lat || !long) {
                return res.status(400).json({
                    message: 'cardCode, lat, and long are required.',
                });
            }

            let user = await UserModel.findOne({ CardCode: cardCode });

            if (user) {
                user.Lat = lat;
                user.Long = long;
                await user.save();
            } else {
                user = await User.create({
                    CardCode: cardCode,
                    Lat: lat,
                    Long: long,
                });
            }

            return res.status(200).json({
                message: user.created_at ? 'User created successfully.' : 'User location updated.',
                data: user,
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

    partial = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID } = req.params;
            const { partial, DueDate } = req.body;

            if (!DueDate) {
                return res.status(400).send({
                    message: "Missing required fields: DueDate "
                });
            }

            let invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (invoice) {
                invoice.partial = partial ? true : false;
                await invoice.save();

            } else {
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    DueDate: parseLocalDateString(DueDate),
                    partial: partial ? true : false,

                });
            }

            return res.status(200).send({
                message: invoice ? "Invoice updated successfully." : "Invoice created successfully.",
                DocEntry,
                InstlmntID,
                partial: invoice.partial,
                _id: invoice._id,
            });
        } catch (e) {
            next(e);
        }
    };
}

module.exports = new b1HANA();


