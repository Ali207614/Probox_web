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
        const token = tokenService.generateJwt(user[0])
        return res.status(201).json({
            token, data: {
                SlpCode: get(user, '[0].SlpCode'),
                SlpName: get(user, '[0].SlpName'),
                U_role: get(user, '[0].U_role')
            }
        })
    };

    invoice = async (req, res, next) => {
        let { startDate, endDate, page = 1, limit = 20, slpCode, paymentStatus } = req.query

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

            const invoices = await InvoiceModel.find(filter)
                .skip(skip)
                .limit(limit)
                .sort({ DocDate: -1 });

            const total = await InvoiceModel.countDocuments(filter);

            res.json({
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

        const query = await DataRepositories.getInvoice({ startDate, endDate, limit, offset: skip, paymentStatus });
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
}

module.exports = new b1HANA();


