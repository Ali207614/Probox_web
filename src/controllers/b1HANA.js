const { get } = require("lodash");
const tokenService = require('../services/tokenService');
const { v4: uuidv4, validate } = require('uuid');
let dbService = require('../services/dbService')


const DataRepositories = require("../repositories/dataRepositories");
const ApiError = require("../exceptions/api-error");
const InvoiceModel = require("../models/invoice-model");

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
    };

    invoice = async (req, res, next) => {
        let { startDate, endDate, page = 1, limit = 20, slpCode, paymentStatus, cardCode, serial, phone } = req.query

        page = parseInt(page, 10);
        limit = parseInt(limit, 10);

        const skip = (page - 1) * limit;

        if (Number(slpCode)) {
            const filter = {};

            if (startDate || endDate) {
                filter.DocDate = {};
                if (startDate) filter.DocDate.$gte = new Date(startDate);
                if (endDate) filter.DocDate.$lte = new Date(endDate);
            }

            filter.slpCode = slpCode;

            if (cardCode) {
                filter.CardCode = cardCode
            }

            if (paymentStatus) {
                if (paymentStatus === "paid") {
                    filter.$expr = { $eq: ["$InsTotal", "$PaidToDate"] };
                } else if (paymentStatus === "unpaid") {
                    filter.$expr = { $eq: ["$PaidToDate", 0] };
                } else if (paymentStatus === "partial") {
                    filter.$expr = {
                        $and: [
                            { $gt: ["$PaidToDate", 0] },
                            { $lt: ["$PaidToDate", "$InsTotal"] }
                        ]
                    };
                }
            }


            if (phone) {
                if (!filter.$or) filter.$or = [];
                filter.$or.push(
                    { Phone1: { $regex: phone, $options: 'i' } },
                    { Phone2: { $regex: phone, $options: 'i' } }
                );
            }

            if (serial) {
                filter.IntrSerial = { $regex: serial, $options: 'i' };
            }

            const invoices = await InvoiceModel.find(filter)
                .skip(skip)
                .limit(limit)
                .sort({ DocDate: -1 });

            const total = await InvoiceModel.countDocuments(filter);

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data: invoices
            });

        }
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();

        if (!startDate) {
            startDate = new Date(year, month, 1).toISOString().split('T')[0];
        }

        if (!endDate) {
            endDate = new Date(year, month + 1, 0).toISOString().split('T')[0];
        }

        const query = await DataRepositories.getInvoice({ startDate, endDate, limit, offset: skip, paymentStatus, cardCode, serial, phone });
        let invoices = await this.execute(query);
        let total = get(invoices, '[0].Count', 0) || 0

        return res.status(200).json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            data: invoices
        });
    };

    search = async (req, res, next) => {
        let { startDate, endDate, page = 1, limit = 50, slpCode, paymentStatus, search, phone } = req.query

        page = parseInt(page, 10);
        limit = parseInt(limit, 10);

        const skip = (page - 1) * limit;

        if (Number(slpCode)) {
            const filter = {};

            if (startDate || endDate) {
                filter.DocDate = {};
                if (startDate) filter.DocDate.$gte = new Date(startDate);
                if (endDate) filter.DocDate.$lte = new Date(endDate);
            }

            filter.slpCode = slpCode;

            if (paymentStatus) {
                if (paymentStatus === "paid") {
                    filter.$expr = { $eq: ["$InsTotal", "$PaidToDate"] };
                } else if (paymentStatus === "unpaid") {
                    filter.$expr = { $eq: ["$PaidToDate", 0] };
                } else if (paymentStatus === "partial") {
                    filter.$expr = {
                        $and: [
                            { $gt: ["$PaidToDate", 0] },
                            { $lt: ["$PaidToDate", "$InsTotal"] }
                        ]
                    };
                }
            }

            if (search) {
                if (!filter.$or) filter.$or = [];
                filter.$or.push(
                    { IntrSerial: { $regex: search, $options: 'i' } },
                    { CardName: { $regex: search, $options: 'i' } }
                );
            }

            if (phone) {
                if (!filter.$or) filter.$or = [];
                filter.$or.push(
                    { Phone1: { $regex: search, $options: 'i' } },
                    { Phone2: { $regex: search, $options: 'i' } }
                );
            }


            const invoices = await InvoiceModel.find(filter)
                .skip(skip)
                .limit(limit)
                .sort({ DocDate: -1 });

            const total = await InvoiceModel.countDocuments(filter);

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data: invoices.map(el => ({ CardCode: el.CardCode, CardName: el.CardName, Phone1: el.Phone1, Phone2: el.Phone2, IntrSerial: el.IntrSerial }))
            });

        }
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();

        if (!startDate) {
            startDate = new Date(year, month, 1).toISOString().split('T')[0];
        }

        if (!endDate) {
            endDate = new Date(year, month + 1, 0).toISOString().split('T')[0];
        }

        const query = await DataRepositories.getInvoiceSearchBPorSeria({ startDate, endDate, limit, offset: skip, paymentStatus, search, phone });
        let invoices = await this.execute(query);
        let total = get(invoices, '[0].Count', 0) || 0

        return res.status(200).json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            data: invoices
        });
    };

    executors = async (req, res, next) => {
        const query = await DataRepositories.getSalesPersons();
        let data = await this.execute(query);
        let total = data.length

        return res.status(200).json({
            total,
            data
        });
    };

    getRate = async (req, res, next) => {
        const query = await DataRepositories.getRate(req.query)
        let data = await this.execute(query)
        return res.status(200).json({ ...data[0] })
    }


    getPayList = async (req, res, next) => {
        const { id } = req.params
        const query = await DataRepositories.getPayList({ docEntry: id })

        let data = await this.execute(query)
        let InstIdList = [...new Set(data.map(el => el.InstlmntID))]
        let result = InstIdList.map(el => {
            let list = data.filter(item => item.InstlmntID == el)
            return {
                DueDate: get(list, `[0].DueDate`, 0),
                InstlmntID: el,
                PaidToDate: get(list, `[0].PaidToDate`, 0),
                InsTotal: get(list, `[0].InsTotal`, 0),
                PaysList: list.map(item => ({ SumApplied: item.SumApplied, AcctName: item.AcctName, DocDate: item.DocDate, CashAcct: item.CashAcct, CheckAcct: item.CheckAcct }))
            }
        })
        return res.status(200).json(result)
    }



}

module.exports = new b1HANA();


