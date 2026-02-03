const { get } = require("lodash");
const tokenService = require('../services/tokenService');
const { v4: uuidv4 } = require('uuid');
const path = require('path')
const fs = require('fs/promises')
let dbService = require('../services/dbService')
const DataRepositories = require("../repositories/dataRepositories");
const ApiError = require("../exceptions/api-error");
const InvoiceModel = require("../models/invoice-model");
const CommentModel = require("../models/comment-model")
const UserModel = require("../models/user-model")
const b1Sl = require('./b1SL')
const { shuffleArray, parseLocalDateString, addAndCondition } = require("../helpers");
const {handleOnlinePbxPayload} = require("../utils/onlinepbx.service");
const moment = require('moment-timezone')
const fsPromises = require('fs/promises');
const {notIncExecutorRole} = require("../config");
const LeadModel = require('../models/lead-model')
const BranchModel= require('../models/branch-model')
const ffmpeg = require('fluent-ffmpeg');
const ffprobeStatic = require('ffprobe-static');
const permissions = require('../utils/lead-permissions')
const { validateFields } = require("../utils/validate-types")
const { generateShortId } = require("../utils/createLead");
const assignBalancedOperator = require("../utils/assignBalancedOperator");
const LeadChat = require("../models/lead-chat-model");

const LeadLimitUsageModel = require('../models/lead-limit-usage');
ffmpeg.setFfprobePath(ffprobeStatic.path);
require('dotenv').config();

const { createOnlinePbx } = require('./pbx.client');
const {syncLeadPbxChats} = require("../services/lead_pbx_sync.service");
const axios = require("axios");

const pbxClient = createOnlinePbx({
    domain: process.env.PBX_DOMAIN,
    authKey: process.env.PBX_AUTH_KEY,
    apiHost: process.env.PBX_API_HOST || 'https://api2.onlinepbx.ru',
});
let lastScoringIndex = -1;


class b1HANA {

    async assignScoringOperator() {
        const scoringQuery = DataRepositories.getSalesPersons({
            include: ['Scoring'],
        });
        const scoringData = await this.execute(scoringQuery);

        if (scoringData.length === 0) {
            console.warn('No Scoring operator found');
            return null;
        }

        lastScoringIndex = (lastScoringIndex + 1) % scoringData.length;

        const selected = scoringData[lastScoringIndex];
        return selected?.SlpCode || null;
    }

    getPurchaseDetail = async (req, res, next) => {
        try {
            const { source, docEntry } = req.params;

            if (source !== 'doc' && source !== 'draft') {
                return res.status(400).json({ message: 'source must be doc or draft' });
            }
            if (!docEntry) {
                return res.status(400).json({ message: 'docEntry is required' });
            }

            const { headerSql, dataSql } = DataRepositories.getPurchaseDetail({
                source,
                docEntry,
            });

            const headerRows = await this.execute(headerSql);
            const header = headerRows?.[0];

            if (!header) {
                return res.status(404).json({ message: 'Document not found' });
            }

            const items = await this.execute(dataSql);

            res.json({
                ...header,
                whsCode: items?.[0]?.whsCode ?? null,
                items,
            });
        } catch (e) {
            next(e);
        }
    };

    parseGroupPairs = (groupPairs) => {
        if (!groupPairs) return [];

        return String(groupPairs)
            .split('||')
            .filter(Boolean)
            .map((p) => {
                const [code, name] = p.split('::');
                return { code: Number(code), name };
            });
    };

    getPurchases = async (req, res, next) => {
        try {
            const { search, status, dateFrom, dateTo, limit = 20, offset = 0 } = req.query;

            const { dataSql, countSql } = DataRepositories.getPurchases({
                search,
                status,
                dateFrom,
                dateTo,
                limit: Number(limit),
                offset: Number(offset),
            });

            const totalRow = await this.execute(countSql);
            const total = Number(totalRow?.[0]?.total ?? 0);

            const itemsRaw = await this.execute(dataSql);

            const items = (itemsRaw || []).map((x) => {
                const groups = this.parseGroupPairs(x.groupPairs);

                return {
                    ...x,
                    groups,                              // [{code, name}, ...]
                    groupCodes: groups.map(g => g.code), // [12, 7]
                };
            });

            res.json({
                total,
                totalPage: Math.ceil(total / Number(limit)),
                items,
            });
        } catch (e) {
            next(e);
        }
    };

    normalizeOnlinePbxPayload = (body) => {
        const out = {};
        for (const [k, v] of Object.entries(body || {})) {
            if (v === 'no value' || v === '' || v == null) out[k] = null;
            else out[k] = v;
        }

        // date: unix seconds -> ISO
        if (out.date) {
            const n = Number(out.date);
            if (!Number.isNaN(n)) out.date_iso = new Date(n * 1000).toISOString();
        }

        // uuid oxirida xato belgilar kelib qolsa (sizda oxirida "v" kelib qolgan)
        if (typeof out.uuid === 'string') {
            out.uuid = out.uuid.trim();
            // UUID formatdan tashqaridagi oxirgi belgilarni kesib tashlash (eng sodda)
            const m = out.uuid.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (m) out.uuid = m[0];
        }

        return out;
    };

    onlinePbxWebhook = async (req, res, next) => {
        try {
            // req.body form-urlencoded bo'lgani uchun express.urlencoded() middleware kerak
            const payload = this.normalizeOnlinePbxPayload(req.body);

            console.log('--- ONLINEPBX ---');
            console.log('event:', payload.event);
            console.log('direction:', payload.direction);
            console.log('uuid:', payload.uuid);
            console.log('caller:', payload.caller);
            console.log('callee:', payload.callee);
            console.log('date:', payload.date_iso || payload.date || payload.data);
            // console.log('full:', payload);

            const result = await handleOnlinePbxPayload(payload);
            return res.status(200).json(result);
        } catch (e) {
            next(e);
        }
    }

    execute = async (sql) => {
        try {
            return dbService.execute(sql);
        } catch (e) {
            throw new Error(e);
        }
    };

    getSuppliers = async (req, res, next) => {
        try {
            const { search = '', limit = 50, offset = 0 } = req.query;

            const sql = DataRepositories.getSuppliers({ search, limit, offset });
            const rows = await this.execute(sql);

            const total = rows?.length ? Number(rows[0].total) : 0;
            const suppliers = (rows || []).map(({ total, ...x }) => x);

            res.json({ total, totalPage: Math.ceil(total / Number(limit || 50)), suppliers });
        } catch (e) {
            next(e);
        }
    };

    getItemGroups = async (req, res, next) => {
        try {
            const { search = '', limit = 50, offset = 0 } = req.query;

            const sql = DataRepositories.getItemGroups({ search, limit, offset });
            const rows = await this.execute(sql);

            const total = rows?.length ? Number(rows[0].total) : 0;

            const groups = (rows || []).map(({ total, ...x }) => x);

            res.json({ total, totalPage: Math.ceil(total / Number(limit || 50)), groups });
        } catch (e) {
            next(e);
        }
    };

    getItems = async (req, res, next) => {
        try {
            const {
                search,
                whsCode,
                limit = 20,
                offset = 0,
                includeZeroOnHand = 'false',
                ...filters
            } = req.query;

            const { dataSql, countSql } = DataRepositories.getItems({
                search,
                filters,
                limit: Number(limit),
                offset: Number(offset),
                whsCode,
                includeZeroOnHand: String(includeZeroOnHand).toLowerCase() === 'true',
            });

            const totalRow = await this.execute(countSql);
            const total = Number(totalRow?.[0]?.total ?? 0);

            const items = await this.execute(dataSql);

            res.json({ total, totalPage: Math.ceil(total / limit), items });
        } catch (e) {
            next(e);
        }
    };

    getScore = async (req, res, next) => {
        try {

            const { CardCode } = req.query

            if(!CardCode){
                return res.status(400).json({
                    message: 'CardCode is required'
                });
            }
            const score = await this.calculateLeadPaymentScore(CardCode);

            res.json({
                score
            });
            return
        }
        catch (e) {
            next(e);
        }
    };

    getLimitUsage = async (req, res, next) => {
        try {
            const { CardCode, jshshir, passportId } = req.query;

            let filter = null;

            if (CardCode) {
                filter = { "actor.cardCode": CardCode };
            } else if (jshshir) {
                filter = { "actor.jshshir": jshshir };
            } else if (passportId) {
                filter = { "actor.passportId": passportId };
            }

            if (!filter) {
                return res.status(400).json({
                    message: "CardCode yoki jshshir yoki passportId kerak",
                });
            }

            const limitUsage = await LeadLimitUsageModel.find(filter).sort({ createdAt: -1 });
            return res.json(limitUsage);

        }
        catch (e) {
            next(e);
        }
    };

    getItemSeries = async (req, res, next) => {
        try {
            const {
                itemCode,
                whsCode,
            } = req.query;

            if (!itemCode) {
                return next(ApiError.BadRequest('WhsCode/ItemCode is required '));
            }

            const query = DataRepositories.getItemSeries({
                whsCode,
                itemCode,
            });

            const rows = await this.execute(query);

            const total = rows[0]?.TotalCount ?? 0;

            const items = rows.map(({ TotalCount, ...rest }) => rest);

            res.json({ total, items });
        }
        catch (e) {
            next(e);
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
            if (user.length === 0) {
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
                    U_role: user[0].U_role,
                    U_branch: user[0].U_branch,
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

            const startDateMoment = moment(startDate, 'YYYY.MM.DD').startOf('day').toDate();
            const endDateMoment = moment(endDate, 'YYYY.MM.DD').endOf('day').toDate();

            if (search) {
                search = search.replace(/'/g, "''");    // SQL injectionni oldini oladi
            }

            const slpCodeRaw = req.query.slpCode;
            const slpCodeArray = slpCodeRaw?.split(',').map(Number).filter(n => !isNaN(n));

            let invoicesModel = [];

            if (slpCode && Array.isArray(slpCodeArray) && slpCodeArray.length > 0) {
                const isUndistributed = String(slpCode) === '56';

                // 1) Mongo: include/exclude lists
                let invoicesModel = [];   // include list (oddiy slpCode lar uchun)
                let excludeModel = [];    // exclude list (slpCode=56 uchun)
                let partialModel = [];

                // 2) Mongo filters (faqat bo‘linganlar uchun)
                const baseMongoFilter = {
                    DueDate: { $gte: startDateMoment, $lte: endDateMoment },
                };

                // phoneConfiscated filter (sizdagi logika)
                const applyPhoneConfiscatedFilter = (f) => {
                    if (phoneConfiscated === 'true') {
                        f.phoneConfiscated = true;
                    } else if (phoneConfiscated === 'false') {
                        f.$or = [
                            { phoneConfiscated: false },
                            { phoneConfiscated: { $exists: false } },
                        ];
                    }
                };

                // 3) Undistributed (slpCode=56) => Mongo’dan bo‘linganlarni olib, SAP’da NOT EXISTS qilamiz
                if (isUndistributed) {
                    // bu yerda SlpCode IN emas — chunki 56 bo‘linmagan, Mongo’da yo‘q.
                    // Mongo’da borlari bo‘linganlar, shularni exclude qilamiz.
                    const excludeFilter = { ...baseMongoFilter };

                    // Siz xohlasangiz bo‘linganlar sharti: SlpCode mavjud bo‘lsin
                    excludeFilter.SlpCode = { $exists: true };

                    // phoneConfiscated filterini exclude listga qo‘shish shart emas,
                    // chunki bo‘linmaganlar Mongo’da yo‘q, bu filter SAP natijasiga ta’sir qilmaydi.
                    // (agar siz 56 uchun ham phoneConfiscated bo‘yicha exclude qilishni xohlasangiz,
                    // unda bo‘linganlar orasidan phoneConfiscated bo‘yicha ham exclude qilishingiz kerak bo‘ladi.)

                    excludeModel = await InvoiceModel.find(excludeFilter, {
                        DocEntry: 1,
                        InstlmntID: 1,
                    })
                        .lean();
                } else {
                    // 4) Normal case => Mongo’dan bo‘linganlarni olish (include list)
                    const includeFilter = {
                        ...baseMongoFilter,
                        SlpCode: { $in: slpCodeArray },
                    };
                    applyPhoneConfiscatedFilter(includeFilter);

                    const partialFilter = {
                        ...baseMongoFilter,
                        SlpCode: { $in: slpCodeArray },
                    };
                    applyPhoneConfiscatedFilter(partialFilter);

                    // paid/partial bo‘lsa partialModel kerak (sizdagi kabi)
                    const ps = (paymentStatus || '').split(',').map(s => s.trim());
                    const needsPartialModel = ps.includes('paid') || ps.includes('partial');

                    if (needsPartialModel) {
                        partialFilter.partial = true;

                        partialModel = await InvoiceModel.find(partialFilter, {
                            phoneConfiscated: 1,
                            DocEntry: 1,
                            InstlmntID: 1,
                            SlpCode: 1,
                            images: 1,
                            newDueDate: 1,
                            CardCode: 1,
                            partial: 1,
                        })
                            .sort({ DueDate: 1 })
                            .hint({ SlpCode: 1, DueDate: 1 })
                            .lean();
                    }

                    invoicesModel = await InvoiceModel.find(includeFilter, {
                        phoneConfiscated: 1,
                        DocEntry: 1,
                        InstlmntID: 1,
                        SlpCode: 1,
                        images: 1,
                        newDueDate: 1,
                        CardCode: 1,
                        partial: 1,
                    })
                        .sort({ DueDate: 1 })
                        .hint({ SlpCode: 1, DueDate: 1 })
                        .lean();

                    // Normal case’da include list bo‘sh bo‘lsa — ha, qaytaramiz (sizdagi kabi)
                    if (invoicesModel.length === 0) {
                        return res.status(200).json({ total: 0, page, limit, totalPages: 0, data: [] });
                    }
                }

                // 5) SAP query (include yoki exclude bilan)
                const query = await DataRepositories.getDistributionInvoice({
                    startDate,
                    endDate,
                    limit,
                    offset: skip,
                    paymentStatus,
                    cardCode,
                    serial,
                    phone,
                    invoices: invoicesModel,          // include list (normal case)
                    excludeInvoices: excludeModel,    // exclude list (slpCode=56 case)
                    partial: partialModel,
                    search,
                });

                const invoices = await this.execute(query);
                const total = get(invoices, '[0].TOTAL', 0) || 0;

                const commentFilter = invoices.map(el => ({
                    DocEntry: el.DocEntry,
                    InstlmntID: el.InstlmntID,
                }));

                const comments = commentFilter.length
                    ? await CommentModel.find({ $or: commentFilter }).sort({ created_at: 1 })
                    : [];

                const commentMap = {};
                for (const c of comments) {
                    const key = `${c.DocEntry}_${c.InstlmntID}`;
                    if (!commentMap[key]) commentMap[key] = [];
                    commentMap[key].push(c);
                }

                const cardCodes = invoices.map(el => el.CardCode).filter(Boolean);
                const userModel = cardCodes.length
                    ? await UserModel.find({ CardCode: { $in: cardCodes } })
                    : [];

                const userLocationMap = new Map();
                userModel.forEach(user => {
                    if (user.CardCode) {
                        userLocationMap.set(user.CardCode, {
                            lat: user.lat || null,
                            long: user.long || null,
                        });
                    }
                });

                const invoiceMap = new Map();
                if (!isUndistributed) {
                    for (const inv of invoicesModel) {
                        invoiceMap.set(`${inv.DocEntry}_${inv.InstlmntID}`, inv);
                    }
                }

                const data = invoices.map(el => {
                    const key = `${el.DocEntry}_${el.InstlmntID}`;
                    const inv = invoiceMap.get(key); // 56 bo‘lsa undefined bo‘ladi
                    const userLocation = userLocationMap.get(el.CardCode) || {};

                    return {
                        ...el,
                        SlpCode: inv?.SlpCode ?? null,
                        Images: inv?.images ?? [],
                        NewDueDate: inv?.newDueDate ?? '',
                        Comments: commentMap[key] || [],
                        phoneConfiscated: inv?.phoneConfiscated ?? false,
                        partial: inv?.partial ?? false,
                        location: {
                            lat: userLocation.lat || null,
                            long: userLocation.long || null,
                        },
                    };
                });

                return res.status(200).json({
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                    data,
                });
            }


            // slpCode bo'lmagan holat
            let baseFilter = {
                DueDate: {
                    $gte: startDateMoment,
                    $lte: endDateMoment
                }
            };

            let baseFilterPartial = {
                DueDate: {
                    $gte: startDateMoment,
                    $lte: endDateMoment
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
                if (invoiceConfiscated.length === 0) {
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

            if (paymentStatus?.split(',').includes('paid') || paymentStatus?.split(',').includes('partial')) {
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
                        lat: user.lat || null,
                        long: user.long || null,
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
                    partial: inv?.partial || false,
                    location:{
                        lat: userLocation.lat || null,
                        long: userLocation.long || null,
                    }
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
            console.log(e , ' bu eeee')
            next(e);
        }
    };

    leads = async (req, res, next) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const skip = (page - 1) * limit;

            const {
                search,
                source,
                branch,
                operator,
                operator2,
                meetingDateStart,
                meetingDateEnd,
                meeting,
                purchase,
                called,
                answered,
                interested,
                called2,
                answered2,
                passportId,
                jshshir,
                scoreMin,
                scoreMax,
                mib,
                aliment,
                officialSalaryMin,
                officialSalaryMax,
                finalLimit,
                finalPercentageMin,
                finalPercentageMax,
                scoring,
                seller,
                isBlocked,
                meetingHappened,
                passportVisit,
                callCount2,
                callCount
            } = req.query;

            const filter = {};

            const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const parseArray = (val) => {
                if (!val) return null;
                if (Array.isArray(val)) return val;
                return val.split(',').map((v) => v.trim()).filter(Boolean);
            };

            const normalizePhone = (str) => {
                if (!str) return '';
                return str.replace(/\D+/g, '');
            };

            if (search) {
                const safeSearch = escapeRegex(search.trim());
                const phoneSearch = normalizePhone(search);

                if (/^\d+$/.test(phoneSearch) && phoneSearch.length >= 2) {
                    filter.$or = [
                        { clientPhone: { $regex: phoneSearch, $options: '' } },
                        { clientPhone2: { $regex: phoneSearch, $options: '' } },
                    ];
                }
                else {
                    filter.$or = [
                        { clientName: { $regex: safeSearch, $options: 'i' } },
                        { comment: { $regex: safeSearch, $options: 'i' } },
                    ];
                }
            }
            const sources = parseArray(source);
            const branches = parseArray(branch);
            const operators = parseArray(operator);
            const operators2 = parseArray(operator2);
            const scorings = parseArray(scoring);
            const sellers = parseArray(seller);

            const statuses = parseArray(req.query.status);
            if (statuses?.length && !statuses.includes('unmarked')) {
                filter.status = { $in: statuses };
            }

            if(callCount2) filter.callCount2 = parseInt(callCount2);
            if(callCount) filter.callCount = parseInt(callCount);

            if (sources?.length) addAndCondition(filter, { source: { $in: sources } });
            if (branches?.length) filter.branch = { $in: branches };
            if (operators?.length) filter.operator = { $in: operators };
            if (operators2?.length) filter.operator2 = { $in: operators2 };
            if (scorings?.length) filter.scoring = { $in: scorings };
            if (sellers?.length) filter.seller = { $in: sellers };

            function parseYesNoUnmarked(value, field, isNumeric = false) {
                if (value === undefined) return;

                if (isNumeric) {
                    if (value === 'yes') addAndCondition(filter, { [field]: { $gt: 0 } });
                    else if (value === 'no') addAndCondition(filter, { [field]: 0 });
                    else if (value === 'unmarked') addAndCondition(filter, { [field]: null });
                } else {
                    if (value === 'yes') filter[field] = true;
                    else if (value === 'no') filter[field] = false;
                    else if (value === 'unmarked') addAndCondition(filter, { [field]: null });
                }
            }

            if (meetingDateStart || meetingDateEnd) {
                let field;
                if (meeting === 'time') field = 'time';
                else if (meeting === 'meetingDate') field = 'meetingDate';
                else if (meeting === 'meetingConfirmedDate') field = 'meetingConfirmedDate';
                else field = 'meetingDate';

                const parseDate = (val) => {
                    if (!val) return null;
                    const clean = val.trim().replace(/\//g, '.');
                    const d = moment(clean, ['DD.MM.YYYY', 'YYYY.MM.DD'], true);
                    return d.isValid() ? d.toDate() : null;
                };

                const start = parseDate(meetingDateStart);
                const end = parseDate(meetingDateEnd);
                if (end) end.setHours(23, 59, 59, 999);

                filter[field] = {};
                if (start) filter[field].$gte = start;
                if (end) filter[field].$lte = end;
            }

            parseYesNoUnmarked(purchase, 'purchase');
            parseYesNoUnmarked(called, 'called');
            parseYesNoUnmarked(answered, 'answered');
            parseYesNoUnmarked(interested, 'interested');
            parseYesNoUnmarked(called2, 'called2');
            parseYesNoUnmarked(answered2, 'answered2');
            parseYesNoUnmarked(mib, 'mib');
            parseYesNoUnmarked(aliment, 'aliment');
            parseYesNoUnmarked(finalLimit, 'finalLimit', true);
            parseYesNoUnmarked(meetingHappened, 'meetingHappened');

            if(isBlocked){
                if(isBlocked === 'yes'){
                    filter.isBlocked = true;
                }
                else if(isBlocked === 'unmarked' || isBlocked === 'no'){
                    addAndCondition(filter, {
                        $or: [
                            { isBlocked: { $exists: false } },
                            { isBlocked: null },
                            { isBlocked: false },
                        ],
                    });

                }
            }

            if (passportId) {
                if (passportId === 'yes') {
                    filter.passportId = { $exists: true, $nin: [null, ''] };
                } else if (passportId === 'no') {
                    addAndCondition(filter, {
                        $or: [
                            { passportId: { $exists: false } },
                            { passportId: null },
                            { passportId: '' },
                        ],
                    });
                } else if (passportId === 'unmarked') {
                    addAndCondition(filter, { passportId: null });
                }
            }

            if (jshshir) {
                if (jshshir === 'yes') {
                    filter.jshshir = { $exists: true, $nin: [null, ''] };
                } else if (jshshir === 'no') {
                    addAndCondition(filter, {
                        $or: [
                            { jshshir: { $exists: false } },
                            { jshshir: null },
                            { jshshir: '' },
                        ],
                    });
                } else if (jshshir === 'unmarked') {
                    addAndCondition(filter, { jshshir: null });
                }
            }

            if (['Passport', 'Visit', 'Processing'].includes(passportVisit)) {
                filter.passportVisit = passportVisit;
            }


            if (req.user?.U_role === 'Scoring') {
                addAndCondition(filter, {
                    $or: [
                        { source: 'Qayta sotuv' },
                        {
                            $and: [
                                { source: { $ne: 'Qayta sotuv' } },
                                {
                                    $or: [
                                        { passportId: { $exists: true, $nin: [null, ''] } },
                                        { jshshir: { $exists: true, $nin: [null, ''] } },
                                    ],
                                },
                            ],
                        },
                    ],
                });
            }

            if (req.user?.U_role !== 'Scoring') {
                addAndCondition(filter, {
                    $or: [
                        { source: { $ne: 'Qayta sotuv' } },
                        {
                            source: 'Qayta sotuv',
                            $or: [
                                { finalLimit: { $gt: 0 } },
                                { finalPercentage: { $gt: 0 } }
                            ],
                        },
                    ],
                });
            }

            const addRangeFilter = (field, min, max) => {
                if (min || max) {
                    filter[field] = {};
                    if (min) filter[field].$gte = parseFloat(min);
                    if (max) filter[field].$lte = parseFloat(max);
                }
            };

            addRangeFilter('score', scoreMin, scoreMax);
            addRangeFilter('officialSalary', officialSalaryMin, officialSalaryMax);
            addRangeFilter('finalPercentage', finalPercentageMin, finalPercentageMax);

            const total = await LeadModel.countDocuments(filter);

            const rawData = await LeadModel.aggregate([
                { $match: filter },
                {
                    $addFields: {
                        _statusOrder: { $cond: [{ $eq: ['$status', 'Returned'] }, 0, 1] },
                    },
                },
                { $sort: { _statusOrder: 1, time: -1 } },
                { $skip: skip },
                { $limit: limit },
                { $project: { _statusOrder: 0 } },
            ]);

            const data = rawData.map((item) => ({
                n: item.n,
                id: item._id,
                seen:item?.seen,
                clientPhone2: item.clientPhone2 || null,
                address2: item.address2 || null,
                paymentScore: item.paymentScore || null,
                totalContracts: item.totalContracts || null,
                openContracts: item.openContracts || null,
                totalAmount: item.totalAmount || null,
                totalPaid: item.totalPaid || null,
                overdueDebt: item.overdueDebt || null,
                maxDelay: item.maxDelay || null,
                avgPaymentDelay: item.avgPaymentDelay || null,
                callCount: item?.callCount || null,
                callCount2: item?.callCount2 || null,
                meetingHappened: item.meetingHappened || null,
                cardCode:item?.cardCode || null,
                invoiceCreated:item.invoiceCreated || null,
                invoiceDocEntry:item.invoiceDocEntry || null,
                invoiceDocNum:item.invoiceDocNum || null,
                invoiceCreatedAt:item.invoiceCreatedAt || null,
                status: (item.purchase || item.invoiceCreated) ? 'Purchased' : item.status,
                isBlocked: item?.isBlocked ?? false,
                clientName: item.clientName || '',
                jsshir: item.jshshir || '',
                branch2: item.branch2 || '',
                clientPhone: item.clientPhone || '',
                source: item.source || '',
                time: item.time ? moment(item.time).format('YYYY.MM.DD HH:mm') : null,
                operator: item.operator || null,
                operator2: item.operator2 || null,
                branch: item.branch || null,
                comment: item.comment || '',
                meetingConfirmed: item.meetingConfirmed ?? null,
                purchase: item.purchase ?? null,
                called: item.called ?? null,
                answered: item.answered ?? null,
                interested: item.interested ?? null,
                called2: item.called2 ?? null,
                answered2: item.answered2 ?? null,
                scoring: item.scoring || null,
                seller: item.seller || null,
                passportId: item.passportId || '',
                meetingDate: item.meetingDate
                    ? moment(item.meetingDate).format('YYYY.MM.DD HH:mm')
                    : null,
                score: item.score ?? null,
                mib: item.mib ?? null,
                aliment: item.aliment ?? null,
                officialSalary: item.officialSalary ?? null,
                finalLimit: item.finalLimit ?? null,
                finalPercentage: item.finalPercentage ?? null,
                createdAt: item.createdAt || null,
            }));

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data,
            });
        } catch (e) {
            console.error('Error fetching leads:', e);
            next(e);
        }
    };

    createLead = async (req, res, next) => {
        try {
            const {
                source,
                clientName,
                clientPhone,
                branch2,
                seller,
                source2,
                comment,
                operator1
            } = req.body;

            function validatePhone(phone) {
                if (!phone) return false;
                let digits = String(phone).replace(/\D/g, '');
                if (digits.length === 9 && digits.startsWith('9')) digits = '998' + digits;
                const isValid = /^998\d{9}$/.test(digits);
                return isValid ? digits : false;
            }

            // 📌 REQUIRED: source
            if (!source) {
                return res.status(400).json({ message: 'source is required' });
            }

            const allowedSources = ['Manychat', 'Meta', 'Organika', 'Kiruvchi qongiroq', 'Community'];
            if (!allowedSources.includes(source)) {
                return res.status(400).json({
                    message: `Invalid source. Allowed values: ${allowedSources.join(', ')}`,
                });
            }

            // 📌 CLEAN PHONE
            const cleanedPhone = validatePhone(clientPhone);
            if (!cleanedPhone) {
                return res.status(400).json({
                    message: "Telefon raqam formati notog'ri",
                });
            }

            // 📌 REQUIRED FIELDS per source
            const requiredFieldsBySource = {
                Organika: ['clientName', 'clientPhone', 'branch2', 'seller'],
                Community: ['clientName', 'clientPhone'],
                'Kiruvchi qongiroq': ['clientName', 'clientPhone', 'operator1'],
                Manychat: ['clientName', 'clientPhone'],
                Meta: ['clientName', 'clientPhone'],
            };

            const requiredFields = requiredFieldsBySource[source] || [];
            const missingFields = requiredFields.filter(
                (f) => !req.body[f] || String(req.body[f]).trim() === ''
            );

            if (missingFields.length > 0) {
                return res.status(400).json({
                    message: `Majburiy maydonlarni to'ldirish kerak ${source}: ${missingFields.join(', ')}`,
                });
            }

            const now = moment();

            const createdAt =
                source === 'Organika'
                    ? {
                        $gte: now.clone().subtract(10, 'days').startOf('day').toDate(),
                        $lte: now.clone().endOf('day').toDate(),
                    }
                    : {
                        $gte: now.clone().startOf('day').toDate(),
                        $lte: now.clone().endOf('day').toDate(),
                    };

            const query =
                source === 'Organika'
                    ? { clientPhone: cleanedPhone, createdAt ,status:"Active"}
                    : { clientPhone: cleanedPhone, source, createdAt ,status:"Active" };

            const exists = await LeadModel.exists(query);

            if (exists) {
                return res.status(409).json({
                    message: "Bu lead allaqachon mavjud",
                });
            }

            let operator = operator1 || null;
            if (source !== 'Organika' && !operator) {
                operator = await assignBalancedOperator();
            }

            let scoring = null;

            if (source === 'Organika') {
                const scoringQuery = DataRepositories.getSalesPersons({
                    include: ['Scoring'],
                });
                const scoringData = await this.execute(scoringQuery);

                if (scoringData.length > 0) {
                    lastScoringIndex = (lastScoringIndex + 1) % scoringData.length;
                    const selected = scoringData[lastScoringIndex];
                    scoring = selected?.SlpCode || null;
                } else {
                    console.warn('No Scoring operator found');
                }
            }

            const n = await generateShortId('PRO');
            const time = new Date();


            const sapRecord = await b1Sl.findOrCreateBusinessPartner(cleanedPhone, clientName);

            const cardCode = sapRecord?.cardCode || null;
            const cardName = sapRecord?.cardName || null;

            let dataObj = {
                n,
                source,
                clientName:sapRecord?.cardName || clientName,
                clientPhone: cleanedPhone,
                //branch2: branch2 || null,
                seller: seller || null,
                source2: source2 || null,
                comment: comment || null,
                operator,
                scoring,
                time,
                cardCode,
                cardName,
                jshshir:sapRecord?.U_jshshir || null,
                idX: sapRecord?.Cellular || null,
                passportId: sapRecord?.Cellular || null,
                jshshir2: sapRecord?.U_jshshir || null,
            };
            if(cardCode){
                const {
                    score,
                    totalContracts,
                    openContracts,
                    totalAmount,
                    totalPaid,
                    overdueDebt,
                    maxDelay,
                    avgPaymentDelay
                } = await this.calculateLeadPaymentScore(cardCode);

                if (score !== null) {
                    dataObj.paymentScore = score;
                    dataObj.totalContracts = totalContracts;
                    dataObj.openContracts = openContracts;
                    dataObj.totalAmount = totalAmount;
                    dataObj.totalPaid = totalPaid;
                    dataObj.overdueDebt = overdueDebt;
                    dataObj.maxDelay = maxDelay;
                    dataObj.avgPaymentDelay = avgPaymentDelay;
                }
            }


            if (source === 'Organika') {
                dataObj = {
                    ...dataObj,
                    // meetingConfirmed: true,
                    // meetingConfirmedDate: new Date(),
                    branch2,
                    seller,
                };
            }

            const io = req.app.get('io');
            if (io)
                io.emit('new_leads', { ...dataObj, SlpCode: dataObj.seller || dataObj.operator });

            const lead = await LeadModel.create(dataObj);

            return res.status(201).json({
                message: 'Lead created successfully',
                data: lead,
            });

        } catch (e) {
            console.error('Error creating lead:', e);
            next(e);
        }
    };

    calculateScoreByDelay(delay) {
        if (delay <= 0) return 10;
        if (delay <= 6) return 9;
        if (delay <= 12) return 8;
        if (delay <= 18) return 7;
        if (delay <= 24) return 6;
        if (delay <= 30) return 5;
        if (delay <= 36) return 4;
        if (delay <= 42) return 3;
        if (delay <= 48) return 2;
        if (delay <= 54) return 1;
        return 0;
    }

    calculateTotalScore = (installments) => {
        let total = 0;
        let count = 0;

        const today = moment();

        for (const inst of installments) {
            const isFullyPaid = inst.TotalPaid >= inst.InsTotal;

            const paidDate = isFullyPaid
                ? moment(inst.PaidDate)
                : today;

            const delay = paidDate.diff(moment(inst.DueDate), 'days');
            const score = this.calculateScoreByDelay(delay);

            total += score;
            count++;
        }

        if (count === 0) return 0;

        return Number((total / count).toFixed(2));
    };

    calcInternalScore({
                                   score,          // A2
                                   totalAmount,    // B2
                                   totalPaid,      // C2
                                   overdueDebt,    // D2
                                   totalContracts, // E2
                                   openContracts,  // F2
                                   maxDelay,       // G2
                                   avgPaymentDelay // H2
                               }) {
        // Excel: IF(A2="";""; ...)
        if (score == null) return null;

        const B = Number(totalAmount) || 0;
        const C = Number(totalPaid) || 0;
        const D = Number(overdueDebt) || 0;
        const E = Number(totalContracts) || 0;
        const F = Number(openContracts) || 0;
        const G = Number(maxDelay) || 0;
        const H = Number(avgPaymentDelay) || 0;

        const paid = B > 0 ? C / B : 0;        // paid = IFERROR(C2/B2;0)
        const overRate = B > 0 ? D / B : 0;    // IFERROR(D2/B2;0)

        // --- H2 blok (avgPaymentDelay) ---
        // Excel IFS(H2<=0;10; H2<=2;9; ... H2<=30;-15; TRUE;-20)
        let hScore = 0;
        if (avgPaymentDelay !== "" && avgPaymentDelay != null) {
            if (H <= 0) hScore = 10;
            else if (H <= 2) hScore = 9;
            else if (H <= 4) hScore = 8;
            else if (H <= 6) hScore = 7;
            else if (H <= 8) hScore = 6;
            else if (H <= 10) hScore = 5;
            else if (H <= 12) hScore = 4;
            else if (H <= 14) hScore = 3;
            else if (H <= 16) hScore = 2;
            else if (H <= 18) hScore = 1;
            else if (H <= 20) hScore = 0;
            else if (H <= 22) hScore = -3;
            else if (H <= 24) hScore = -6;
            else if (H <= 26) hScore = -9;
            else if (H <= 28) hScore = -12;
            else if (H <= 30) hScore = -15;
            else hScore = -20;
        }

        // --- G2 blok (maxDelay) ---
        // Excel IFS(G2<=2;15; ... G2<=30;1; TRUE;-5)
        let gScore = 0;
        if (maxDelay !== "" && maxDelay != null) {
            if (G <= 2) gScore = 15;
            else if (G <= 4) gScore = 14;
            else if (G <= 6) gScore = 13;
            else if (G <= 8) gScore = 12;
            else if (G <= 10) gScore = 11;
            else if (G <= 12) gScore = 10;
            else if (G <= 14) gScore = 9;
            else if (G <= 16) gScore = 8;
            else if (G <= 18) gScore = 7;
            else if (G <= 20) gScore = 6;
            else if (G <= 22) gScore = 5;
            else if (G <= 24) gScore = 4;
            else if (G <= 26) gScore = 3;
            else if (G <= 28) gScore = 2;
            else if (G <= 30) gScore = 1;
            else gScore = -5;
        }

        // --- overdue rate blok (D2/B2) ---
        // Excel: 0 -> 15; <=0.01 -> 12; <=0.03 -> 6; <=0.05 -> 2; else 0
        let overScore = 0;
        if (overRate === 0) overScore = 15;
        else if (overRate <= 0.01) overScore = 12;
        else if (overRate <= 0.03) overScore = 6;
        else if (overRate <= 0.05) overScore = 2;
        else overScore = 0;

        // --- paid ratio blok (C2/B2) ---
        // Excel: paid>=0.95 -> 15; ... paid>=0.4 -> 4; else 0
        let paidScore = 0;
        if (paid >= 0.95) paidScore = 15;
        else if (paid >= 0.9) paidScore = 14;
        else if (paid >= 0.85) paidScore = 13;
        else if (paid >= 0.8) paidScore = 12;
        else if (paid >= 0.75) paidScore = 11;
        else if (paid >= 0.7) paidScore = 10;
        else if (paid >= 0.65) paidScore = 9;
        else if (paid >= 0.6) paidScore = 8;
        else if (paid >= 0.55) paidScore = 7;
        else if (paid >= 0.5) paidScore = 6;
        else if (paid >= 0.45) paidScore = 5;
        else if (paid >= 0.4) paidScore = 4;
        else paidScore = 0;

        // --- openContracts / totalContracts blok ---
        // Excel: IFERROR(F2/MAX(E2;1);0) <=0.34 -> 5; <=0.6 -> 3; <=0.8 -> 1; else 0
        const openRate = E > 0 ? F / Math.max(E, 1) : 0;
        let openScore = 0;
        if (openRate <= 0.34) openScore = 5;
        else if (openRate <= 0.6) openScore = 3;
        else if (openRate <= 0.8) openScore = 1;
        else openScore = 0;

        // Excel Score = 40*(A2/10) + Hblock + Gblock + overScore + paidScore + openScore
        const rawScore =
            40 * (Number(score) / 10) +
            hScore +
            gScore +
            overScore +
            paidScore +
            openScore;

        // IF(AND(C2=0;D2=0);30; IF(F2>=3; MIN(30;Score); IF(F2=2; MIN(50;Score); Score)))
        let baseFinal;
        if (C === 0 && D === 0) baseFinal = 30;
        else if (F >= 3) baseFinal = Math.min(30, rawScore);
        else if (F === 2) baseFinal = Math.min(50, rawScore);
        else baseFinal = rawScore;

        // paid>=0.9 ->0; >=0.8 ->5; >=0.7 ->10; >=0.6 ->15; else 20
        let penalty = 20;
        if (paid >= 0.9) penalty = 0;
        else if (paid >= 0.8) penalty = 5;
        else if (paid >= 0.7) penalty = 10;
        else if (paid >= 0.6) penalty = 15;

        // Excel: baseFinal - penalty
        return Math.floor(baseFinal - penalty);
    }

    calcTrustLabel({ totalAmount, overdueDebt, maxDelay }) {
        const B = Number(totalAmount) || 0;
        const D = Number(overdueDebt) || 0;
        const G = Number(maxDelay) || 0;

        const overRate = B > 0 ? D / B : 0;

        if (overRate >= 0.03 || D >= 3_000_000 || G >= 51) return 'Xavfli';
        return 'Xavfsiz';
    }

    calcLimit(internalScore, trustLabel) {
        const Risk = Number(internalScore) || 0;
        const hard = String(trustLabel || '').toLowerCase() === 'xavfli';

        let base = 0;
        if (Risk >= 85) base = 30_000_000;
        else if (Risk >= 84) base = 29_000_000;
        else if (Risk >= 83) base = 28_000_000;
        else if (Risk >= 82) base = 27_000_000;
        else if (Risk >= 81) base = 26_000_000;
        else if (Risk >= 80) base = 25_000_000;
        else if (Risk >= 79) base = 24_000_000;
        else if (Risk >= 78) base = 23_000_000;
        else if (Risk >= 77) base = 22_000_000;
        else if (Risk >= 76) base = 21_000_000;
        else if (Risk >= 75) base = 20_000_000;
        else if (Risk >= 74) base = 19_000_000;
        else if (Risk >= 73) base = 18_000_000;
        else if (Risk >= 72) base = 17_000_000;
        else if (Risk >= 71) base = 16_000_000;
        else if (Risk >= 70) base = 15_000_000;
        else if (Risk >= 69) base = 14_000_000;
        else if (Risk >= 68) base = 13_000_000;
        else if (Risk >= 67) base = 12_000_000;
        else if (Risk >= 66) base = 11_000_000;
        else if (Risk >= 65) base = 10_000_000;
        else if (Risk >= 64) base = 9_000_000;
        else if (Risk >= 63) base = 8_000_000;
        else if (Risk >= 62) base = 7_000_000;
        else if (Risk >= 61) base = 6_000_000;
        else if (Risk >= 60) base = 5_000_000;
        else if (Risk >= 55) base = 4_000_000;
        else if (Risk >= 50) base = 3_000_000;
        else if (Risk >= 45) base = 2_000_000;
        else if (Risk >= 40) base = 1_000_000;
        else base = 0;

        return hard ? Math.min(base, 5_000_000) : base;
    }

    calculateLeadPaymentScore = async (cardCode) => {
        const sql = DataRepositories.getInstallmentPaymentsByPerson(cardCode);
        let rows = await this.execute(sql);
        if (!rows || rows.length === 0) {
            return {
                score: 0,
                totalContracts: 0,
                openContracts: 0,
                totalAmount: 0,
                totalPaid: 0,
                overdueDebt: 0,
                maxDelay: 0,
                avgPaymentDelay: 0
            };
        }

        const contractSet = new Set(rows.map(r => r.DocEntry));
        const totalContracts = contractSet.size;

        let totalAmount = 0;
        let totalPaid = 0;

        const installmentsMap = {};
        for (const r of rows) {
            const key = `${r.DocEntry}_${r.InstlmntID}`;
            if (!installmentsMap[key]) {
                installmentsMap[key] = {
                    DocEntry: r.DocEntry,
                    InstlmntID: r.InstlmntID,
                    DueDate: moment(r.DueDate),
                    InsTotal: Number(r.InsTotal),
                    Total: Number(r.Total),
                    PaidTodate: Number(r.TotalPaid),
                    TotalPaid: 0,
                    PaidDate: null
                };
            }

            installmentsMap[key].TotalPaid += Number(r.SumApplied || 0);

            if (r.DocDate) {
                const paymentDate = moment(r.DocDate);
                if (
                    !installmentsMap[key].PaidDate ||
                    paymentDate.isAfter(installmentsMap[key].PaidDate)
                ) {
                    installmentsMap[key].PaidDate = paymentDate;
                }
            }
        }

        const installments = Object.values(installmentsMap);
        const today = moment();
        // ===============================
        // 4. Ochiq shartnomalar
        // ===============================

        const contractMap = {};
        for (const inst of Object.values(installmentsMap)) {

            if (!contractMap[inst.DocEntry]) {
                contractMap[inst.DocEntry] = {
                    total: 0,
                    paid: 0,
                    Total:inst.Total,
                    PaidTodate:inst.PaidTodate
                };
            }

            contractMap[inst.DocEntry].total += inst.InsTotal;
            contractMap[inst.DocEntry].paid += inst.TotalPaid || 0;
        }

        let openContracts = 0;
        for (const docEntry in contractMap) {
            const c = contractMap[docEntry];
            totalAmount += c.Total;
            totalPaid += c.PaidTodate;

            if ((c.Total <= c.PaidTodate + 5)) {
                continue;
            }
            else{
                openContracts+=1
            }
        }
        // ===============================
        // 5. Просрочка (overdue debt)
        // ===============================


        let overdueDebt = 0;
        const filtered = installments.filter((inst) =>
            moment(inst.DueDate).isSameOrBefore(today, 'day')
        );


        for (const inst of installments) {
            const unpaid = inst.InsTotal - inst.TotalPaid;
            if (unpaid <= 0) continue;
            if (inst.DueDate.isBefore(today, 'day')) {
                overdueDebt += unpaid;
            }

        }

        // ===============================
        // 6. Eng cho‘zilgan kun
        // ===============================
        let maxDelay = 0;

        for (const inst of installments) {
            const paidDate =
                inst.TotalPaid >= inst.InsTotal && inst.PaidDate
                    ? inst.PaidDate
                    : today;

            const delay = paidDate.diff(inst.DueDate, 'days');
            if (delay > maxDelay) {
                maxDelay = delay;
            }
        }

        // ===============================
        // 7. O‘rtacha to‘lov kuni
        // ===============================
        let totalDelay = 0;
        let paidCount = 0;


        for (const inst of filtered) {
            if(!inst.PaidDate){
                inst.PaidDate = today;
            }

            const delay = inst.PaidDate.diff(inst.DueDate, 'days');
            totalDelay += delay;
            paidCount++;
        }

        const avgPaymentDelay = paidCount
            ? Math.floor(Number((totalDelay / paidCount)))
            : 0;
        // ===============================
        // 8. SCORE
        // ===============================
        const score = this.calculateTotalScore(installments);

        const internalScore = this.calcInternalScore({
            score,
            totalContracts,
            openContracts,
            totalAmount,
            totalPaid,
            overdueDebt,
            maxDelay,
            avgPaymentDelay
        });

        const trustLabel = this.calcTrustLabel({ totalAmount, overdueDebt, maxDelay });
        const limit = this.calcLimit(internalScore, trustLabel);

        return {
            score,
            totalContracts,
            openContracts,
            totalAmount,
            totalPaid,
            overdueDebt,
            maxDelay,
            avgPaymentDelay,
            internalScore,
            trustLabel,   // "xavfli" | "xavfsiz"
            limit,
            monthlyLimit: Math.floor(limit / 12)
        };
    };

    buildActor = (req , lead) => {
        const u = req.user || {};
        return {
            type: u.U_role, // sizda qanday role bo‘lsa moslang
            id: u._id ? String(u._id) : (u.id ? String(u.id) : null),
            cardCode: lead.cardCode,
            name:lead.cardName,
            jshshir: lead.jshshir,
            passportId: lead.passportId,
        };
    };

    toNumberOrNull = (v) => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    writeLimitUsageHistory = async ({ leadId, existingLead, validData, req }) => {
        const docs = [];

        const newFinalLimit = validData.finalLimit !== undefined ? this.toNumberOrNull(validData.finalLimit) : undefined;
        const newInternalLimit = validData.internalLimit !== undefined ? this.toNumberOrNull(validData.internalLimit) : undefined;
        const newPercentage = validData.finalPercentage !== undefined ? this.toNumberOrNull(validData.finalPercentage) : undefined;

        const oldFinalLimit = this.toNumberOrNull(existingLead.finalLimit);
        const oldInternalLimit = this.toNumberOrNull(existingLead.internalLimit);
        const oldPercentage = this.toNumberOrNull(existingLead.finalPercentage);

        const actor = this.buildActor(req,existingLead);

        const snapshot = {
            finalLimit: newFinalLimit !== undefined ? newFinalLimit : oldFinalLimit,
            internalLimit: newInternalLimit !== undefined ? newInternalLimit : oldInternalLimit,
            percentage: newPercentage !== undefined ? newPercentage : oldPercentage,
            currency: existingLead.currency || 'UZS',
        };

        if (newFinalLimit !== undefined && newFinalLimit !== oldFinalLimit) {
            docs.push({
                leadId,
                usedType: 'finalLimit',
                usedAmount: Math.abs((newFinalLimit ?? 0) - (oldFinalLimit ?? 0)),
                snapshot,
                actor,
                reason: 'manual',
            });
        }

        // internalLimit changed?
        if (newInternalLimit !== undefined && newInternalLimit !== oldInternalLimit) {
            docs.push({
                leadId,
                usedType: 'internalLimit',
                usedAmount: Math.abs((newInternalLimit ?? 0) - (oldInternalLimit ?? 0)),
                snapshot,
                actor,
                reason: 'manual',
            });
        }

        // percentage changed?
        if (newPercentage !== undefined && newPercentage !== oldPercentage) {
            docs.push({
                leadId,
                usedType: 'percentage',
                usedAmount: Math.abs((newPercentage ?? 0) - (oldPercentage ?? 0)),
                snapshot,
                actor,
                reason: 'manual',
            });
        }

        if (docs.length) {
            await LeadLimitUsageModel.insertMany(docs);
        }
    }

    updateLead = async (req, res, next) => {
        try {
            const { id } = req.params;
            const { U_role } = req.user;
            const body = req.body;

            const existingLead = await LeadModel.findById(id).lean();
            if (!existingLead) {
                return res.status(404).json({ message: 'Lead not found' });
            }

            if((existingLead.purchase === true || existingLead.status === 'Purchased') && body.status){
                return res.status(400).json({ message: "Mijoz allaqachon mahsulot sotib olgan shu sababli status o'zgarmaydi" });
            }

            if (!permissions[U_role]) {
                return res.status(403).json({
                    message: `Role ${U_role} is not allowed to update leads`,
                });
            }

            const allowedFields = permissions[U_role];
            const { validData, errors } = validateFields(
                body,
                LeadModel.schema,
                allowedFields
            );

            if (errors.length) {
                return res.status(400).json({
                    message: 'Type validation failed',
                    details: errors,
                });
            }

            const bodyKeys = Object.keys(body);
            const invalidFields = bodyKeys.filter(
                (key) => !allowedFields.includes(key)
            );

            if (Object.keys(validData).length === 0) {
                return res.status(400).json({
                    message: 'No valid fields provided for update',
                    invalidFields: invalidFields.length ? invalidFields : undefined,
                    allowedFields,
                });
            }

            if( validData.callCount && existingLead.callCount  !== validData.callCount) {
                const prev = existingLead.callCount || 0;

                if (validData.callCount - prev !== 1) {
                    return res.status(400).json({
                        message: "Qo'ng'iroqlar soni faqat bittaga oshishi mumkin"
                    });
                }
            }


            if(validData.callCount2 &&  existingLead.callCount2  !== validData.callCount2) {
                const prev = existingLead.callCount2 || 0;

                if (validData.callCount2 - prev !== 1) {
                    return res.status(400).json({
                        message: "Qo'ng'iroqlar soni faqat bittaga oshishi mumkin"
                    });
                }
            }

            if (validData?.interested) {
                const interestedBool = validData.interested === true

                if (!interestedBool) {
                    if (!validData.rejectionReason || String(validData.rejectionReason).trim() === '') {
                        return res.status(400).json({
                            message: "Rad etish sababini to'ldirish kerak ",
                            location: 'rejectionReason_required',
                        });
                    }

                    validData.status = 'Closed';
                }
            }

            if(validData.rejectionReason){
                validData.status = 'Closed';
            }


            if(validData.rejectionReason2){
                validData.status = 'Closed';
            }

            if(validData.status === 'Returned'){
                validData.seen = false
            }

            if (
                (validData.answered === false || existingLead.answered === false) &&
                (Number(validData.callCount) >= 5)
            ) {
                validData.status = 'Closed';
            }


            if(validData.meetingConfirmed){
                validData.meetingHappened = true
            }

            if((validData.rejectionReason2 || validData.rejectionReason) && req.user?.U_role === 'Seller'){
                validData.meetingHappened = true
            }

            // === Normalize fields
            if (validData?.clientFullName) {
                validData.clientName = validData.clientFullName;
                if(existingLead.cardCode){
                    await b1Sl.updateBusinessPartner({
                        CardCode: existingLead.cardCode,
                        CardName: validData.clientFullName,
                        U_jshshir:validData.jshshir || null,
                        Cellular:  validData.passportId || null
                    } )
                }
            }

            if (validData.passportId) {
                validData.idX = validData.passportId;
            } else if (validData.idX) {
                validData.passportId = validData.idX;
            }

            if (validData.jshshir2) {
                validData.jshshir = validData.jshshir2;
            } else if (validData.jshshir) {
                validData.jshshir2 = validData.jshshir;
            }

            // === Validation checks
            if (validData.jshshir) {
                const jshshirStr = String(validData.jshshir).trim();
                validData.jshshir = jshshirStr;
                if (!/^\d{14}$/.test(jshshirStr)) {
                    return res.status(400).json({
                        message: 'JSSHR 14 raqamdan iborat bo\'lishi kerak',
                        location: 'jshshir_invalid',
                    });
                }
            }

            if (validData.passportId) {
                const passportStr = String(validData.passportId).trim();
                validData.passportId = passportStr;
                if (!/^[A-Z]{2}\d{7}$/.test(passportStr)) {
                    return res.status(400).json({
                        message: 'Passport 2 ta harf va 7 raqamdan iborat bo\'lishi kerak',
                        location: 'passport_invalid',
                    });
                }
            }

            if (validData.meetingConfirmed === true) {
                if (!validData.branch2 && !validData.seller) {
                    return res.status(400).json({
                        message: `Uchrashuv bo'lganda filial va sotuvchi tanlash majburiy`,
                    });
                }
            }

            if (validData.passportVisit && validData.passportVisit === 'Passport') {
                if (!validData.jshshir || !validData.jshshir2) {
                    return res.status(400).json({
                        message: 'Passport tanlanganda JSSHR va IDX kiritishi majburiy',
                        location: 'jshshir_required'
                    });
                }

                if (!validData.idX || !validData.passportId) {
                    return res.status(400).json({
                        message: 'Passport tanlanganda JSSHR va IDX kiritishi majburiy',
                        location: 'idX_required'
                    });
                }
            }

            if (
                validData.passportVisit &&
                ['Passport', 'Visit'].includes(validData.passportVisit)
            ) {
                const weekday = moment().isoWeekday().toString();

                if (!existingLead.operator2) {
                    const operator2Query = DataRepositories.getSalesPersons({
                        include: ['Operator2'],
                    });
                    const operator2Data = await this.execute(operator2Query);

                    const availableOperator2s = operator2Data.filter((item) =>
                        (item?.U_workDay || '').split(',').includes(weekday)
                    );

                    if (availableOperator2s.length > 0) {
                        const randomIndex = Math.floor(
                            Math.random() * availableOperator2s.length
                        );
                        const selectedOperator2 = availableOperator2s[randomIndex];
                        validData.operator2 = selectedOperator2?.SlpCode || null;
                    } else {
                        console.warn('No available Operator2 found for today');
                    }
                }

                if (
                    !existingLead.scoring && validData.passportVisit === 'Passport'
                ) {
                    validData.scoring = await this.assignScoringOperator();

                    if (validData.scoring) {
                        const io = req.app.get('io');
                        if (io) {
                            io.emit('scoring_lead', {
                                n: existingLead.n,
                                _id: existingLead._id,
                                source: existingLead.source,
                                clientName: existingLead.clientName,
                                time: existingLead.time,
                                clientPhone: existingLead.clientPhone,
                                SlpCode: validData.scoring
                            });
                        }
                    }
                }
            }

            if (
                validData.jshshir ||
                validData.passportId ||
                validData.clientPhone ||
                existingLead.clientPhone
            ) {
                try {
                    const jshshir = validData.jshshir || validData.jshshir2 || null;
                    const passport = validData.passportId || validData.idX || null;
                    const phoneRaw =
                        validData.clientPhone || existingLead.clientPhone || '';
                    const phone = phoneRaw.replace(/\D/g, '');
                    const query = DataRepositories.getBusinessPartners({ jshshir, passport, phone: `%${phone}` })
                    const sapResult = await this.execute(query);
                    if (sapResult.length > 0) {
                        const record = sapResult[0];

                        validData.isBlocked = record.U_blocked === 'yes';
                        validData.cardCode = record.CardCode;
                        validData.cardName = record.CardName;

                        if (validData.isBlocked !== true) {
                            const {
                                score,
                                totalContracts,
                                openContracts,
                                totalAmount,
                                totalPaid,
                                overdueDebt,
                                maxDelay,
                                avgPaymentDelay
                            } = await this.calculateLeadPaymentScore(record.CardCode);

                            if (score !== null) {
                                validData.paymentScore = score;
                                validData.totalContracts = totalContracts;
                                validData.openContracts = openContracts;
                                validData.totalAmount = totalAmount;
                                validData.totalPaid = totalPaid;
                                validData.overdueDebt = overdueDebt;
                                validData.maxDelay = maxDelay;
                                validData.avgPaymentDelay = avgPaymentDelay;
                            }
                        }

                        console.log(`SAP match found → ${record.CardCode} | ${record.CardName}`);
                    } else {

                        validData.cardCode = null;
                        validData.cardName = null;
                        console.log(`SAP: No record found for ${jshshir || passport || phone}`);
                    }
                } catch (sapErr) {
                    console.warn('SAP check failed:', sapErr.message);
                }
            }

            if(validData.purchase){
                validData.status = 'Purchased'
            }else if(validData.purchase === false){
                validData.status = 'Closed'
            }

            if(validData.finalLimit){
                validData.limitDate = new Date();
            }

            await this.writeLimitUsageHistory({
                leadId: existingLead._id,
                existingLead,
                validData,
                req,
            });

            const updated = await LeadModel.findByIdAndUpdate(id, validData, {
                new: true,
                runValidators: true,
            });

            if (!updated) {
                return res.status(404).json({ message: 'Lead not found' });
            }

            return res.status(200).json({
                message: 'Lead updated successfully',
                data: updated,
            });
        } catch (err) {
            console.error('Error updating lead:', err);
            next(err);
        }
    };

    findAllBranch = async(req, res, next) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const skip = (page - 1) * limit;

            const { search, status, region } = req.query;

            const filter = {};
            if (search) filter.name = { $regex: search, $options: 'i' };
            if (status) filter.status = status;
            if (region) filter.region = { $regex: region, $options: 'i' };

            const total = await BranchModel.countDocuments(filter);

            const branches = await BranchModel.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const data = branches.map((b) => ({
                _id: b._id,
                id: b.id,
                code:b?.code,
                name: b.name,
                region: b.region || null,
                address: b.address || null,
                phone: b.phone || null,
                status: b.status,
                createdAt: b.createdAt,
                updatedAt: b.updatedAt,
            }));

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data,
            });
        } catch (err) {
            console.error('Error fetching branches:', err);
            next(err);
        }
    }

    search = async (req, res, next) => {
        try {
            let {
                startDate,
                endDate,
                page = 1,
                limit = 50,
                slpCode,
                paymentStatus='',
                search,
                phone,
                phoneConfiscated
            } = req.query;

            if (search) {
                search = search.replace(/'/g, "''");
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

            const startDateMoment = moment(startDate, 'YYYY.MM.DD').startOf('day').toDate();
            const endDateMoment = moment(endDate, 'YYYY.MM.DD').endOf('day').toDate();

            const slpCodeRaw = req.query.slpCode;
            const slpCodeArray = slpCodeRaw?.split(',').map(Number).filter(n => !isNaN(n));

            if (slpCode && Array.isArray(slpCodeArray) && slpCodeArray.length > 0) {
                let filter = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: startDateMoment,
                        $lte: endDateMoment,
                    }
                };

                let filterPartial = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: startDateMoment,
                        $lte: endDateMoment
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
                    $gte: startDateMoment,
                    $lte: endDateMoment
                }
            };

            let baseFilterPartial = {
                DueDate: {
                    $gte: startDateMoment,
                    $lte: endDateMoment
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

                if (invoiceConfiscated.length === 0) {
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
            const { exclude_role, include_role , branch } = req.query;

            let notIncExecutorRole = [];
            let onlyIncExecutorRole = [];

            // exclude_role ni arrayga aylantirish
            if (exclude_role) {
                if (Array.isArray(exclude_role)) {
                    notIncExecutorRole = exclude_role;
                } else if (typeof exclude_role === 'string') {
                    notIncExecutorRole = exclude_role.split(',').map(r => r.trim());
                }
            }

            // include_role ni arrayga aylantirish
            if (include_role) {
                if (Array.isArray(include_role)) {
                    onlyIncExecutorRole = include_role;
                } else if (typeof include_role === 'string') {
                    onlyIncExecutorRole = include_role.split(',').map(r => r.trim());
                }
            }

            const query = await DataRepositories.getSalesPersons({
                exclude: notIncExecutorRole,
                include: onlyIncExecutorRole,
                branch
            });

            const data = await this.execute(query);
            const total = data.length;

            return res.status(200).json({
                total,
                data: data.sort((a, b) => b.SlpName.localeCompare(a.SlpName)),
            });
        } catch (e) {
            next(e);
        }
    };

    distribution = async (req, res, next) => {
        try {
            let { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                return res.status(404).json({ error: 'startDate and endDate are required' });
            }

            const executorsQuery = await DataRepositories.getSalesPersons(notIncExecutorRole);
            let executorList = await this.execute(executorsQuery);

            let SalesList = executorList.filter(el => el.U_role === 'Assistant')

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
                        let lastExecutor = existInvoice[existInvoice.length - 1]
                        let isManager = executorList.find(el => el?.SlpCode == lastExecutor?.SlpCode && el?.U_role == 'Manager')
                        let first = isManager ? isManager :  (nonExistList.length ? nonExistList[0] : shuffleArray(SalesList)[0])
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
                return {
                    ItemCode: get(list, `[0].ItemCode`, ''),
                    Dscription: get(list, `[0].Dscription`, ''),
                    CardCode: get(list, `[0].CardCode`, ''),
                    CardName: get(list, `[0].CardName`, ''),
                    MaxDocTotal: get(list, `[0].MaxDocTotal`, 0),
                    MaxDocTotalFC: get(list, `[0].MaxDocTotalFC`, 0),
                    DocCur: get(list, `[0].DocCur`, ''),
                    IntrSerial: get(list, `[0].IntrSerial`, ''),
                    MaxTotalPaidToDate: get(list, `[0].MaxTotalPaidToDate`, 0),
                    MaxTotalPaidToDateFC: get(list, `[0].MaxTotalPaidToDateFC`, 0),
                    Cellular: get(list, `[0].Cellular`, ''),
                    Phone1: get(list, `[0].Phone1`, ''),
                    Phone2: get(list, `[0].Phone2`, ''),
                    InstlmntID: el,
                    DueDate: get(list, `[0].DueDate`, 0),
                    PaidToDate: list?.length ? list.filter(item => (item.Canceled === null || item.Canceled === 'N')).reduce((a, b) => a + Number(b?.SumApplied || 0), 0) : 0,
                    InsTotal: get(list, `[0].InsTotal`, 0),
                    PaidToDateFC:get(list, `[0].PaidFC`, 0),
                    InsTotalFC:get(list, `[0].InsTotalFC`, 0),
                    Images: invoiceItem?.images || [],
                    partial: invoiceItem?.partial || false,
                    phoneConfiscated: invoiceItem?.phoneConfiscated || false,
                    SlpCode: invoiceItem?.SlpCode || null,
                    PaysList: list.filter(i => i.DocDate && (i.Canceled === null || i.Canceled === 'N')).map(item => ({
                        SumApplied: item?.SumApplied || 0,
                        SumAppliedFC: item?.AppliedFC || 0,
                        Currency: item?.Currency || '',
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
                const isUndistributed = String(slpCode) === '56';

                const startDateMoment = moment(startDate, 'YYYY.MM.DD').startOf('day').toDate();
                const endDateMoment = moment(endDate, 'YYYY.MM.DD').endOf('day').toDate();

                const baseMongoFilter = {
                    DueDate: { $gte: startDateMoment, $lte: endDateMoment },
                };


                let invoicesModel = [];
                let excludeModel = [];

                if (isUndistributed) {
                    const excludeFilter = { ...baseMongoFilter };

                    excludeFilter.SlpCode = { $exists: true };

                    excludeModel = await InvoiceModel.find(excludeFilter, {
                        DocEntry: 1,
                        InstlmntID: 1,
                        phoneConfiscated: 1,
                        InsTotal: 1,
                    })
                        .lean();
                } else {
                    const includeFilter = {
                        ...baseMongoFilter,
                        SlpCode: { $in: slpCodeArray },
                    };

                    invoicesModel = await InvoiceModel.find(includeFilter, {
                        phoneConfiscated: 1,
                        DocEntry: 1,
                        InstlmntID: 1,
                        SlpCode: 1,
                        images: 1,
                        newDueDate: 1,
                        CardCode: 1,
                        InsTotal: 1,
                    })
                        .sort({ DueDate: 1 })
                        .hint({ SlpCode: 1, DueDate: 1 })
                        .lean();

                    if (invoicesModel.length === 0) {
                        return res.status(200).json({ SumApplied: 0, InsTotal: 0, PaidToDate: 0 });
                    }
                }

                const sourceForConfiscated = isUndistributed ? excludeModel : invoicesModel;
                const phoneConfisList = (isUndistributed ? [] : invoicesModel).filter(item => !item?.phoneConfiscated);
                const confiscatedTotal =
                    sourceForConfiscated
                        .filter(item => item?.phoneConfiscated)
                        .reduce((a, b) => a + Number(b?.InsTotal || 0), 0) || 0;


                if (!isUndistributed && phoneConfisList.length === 0) {
                    const obj = {
                        SumApplied: confiscatedTotal,
                        InsTotal: confiscatedTotal,
                        PaidToDate: confiscatedTotal,
                    };
                    return res.status(200).json(obj);
                }

                const query = await DataRepositories.getAnalytics({
                    startDate,
                    endDate,
                    invoices: phoneConfisList,
                    excludeInvoices: excludeModel,
                    isUndistributed,
                });

                const data = await this.execute(query);

                const result = data.length
                    ? data.reduce(
                        (acc, item) => ({
                            SumApplied: acc.SumApplied + (+item.SumApplied || 0),
                            InsTotal: acc.InsTotal + (+item.InsTotal2 || 0),
                            PaidToDate: acc.PaidToDate + (+item.PaidToDate || 0),
                        }),
                        { SumApplied: 0, InsTotal: 0, PaidToDate: 0 }
                    )
                    : { SumApplied: 0, InsTotal: 0, PaidToDate: 0 };

                if (result.PaidToDate > result.SumApplied) {
                    const n = result.PaidToDate - result.SumApplied;
                    result.InsTotal = result.InsTotal - n + (isUndistributed ? 0 :confiscatedTotal);
                    result.SumApplied = Number(result.SumApplied) + (isUndistributed ? 0 :confiscatedTotal);
                    result.PaidToDate = result.SumApplied;
                } else {
                    result.SumApplied = Number(result.SumApplied) + (isUndistributed ? 0 :confiscatedTotal);
                    result.InsTotal = Number(result.InsTotal) + (isUndistributed ? 0 :confiscatedTotal);
                    result.PaidToDate = Number(result.PaidToDate);
                }

                return res.status(200).json(result);
            }


            let baseFilter = {
                DueDate: {
                    $gte: moment(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                    $lte: moment(endDate, 'YYYY.MM.DD').endOf('day').toDate()
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
            const query = await DataRepositories.getAnalytics({isUndistributed:true, startDate, endDate, invoices: invoiceConfiscated, phoneConfiscated: 'true' })

            let data = await this.execute(query)
            let result = data.length
                ? data.reduce(
                    (acc, item) => ({
                        SumApplied: acc.SumApplied + Number(item.SumApplied ?? 0),
                        InsTotal: acc.InsTotal + Number(item.InsTotal ?? 0),
                        PaidToDate: acc.PaidToDate + Number(item.PaidToDate ?? 0),
                    }),
                    { SumApplied: 0, InsTotal: 0, PaidToDate: 0 }
                )
                : { SumApplied: 0, InsTotal: 0, PaidToDate: 0 };

            if(result.PaidToDate > result.SumApplied){
                result.SumApplied = Number(result.SumApplied) + confiscatedTotal;
                result.PaidToDate = result.SumApplied;
            }
            else{
                result.SumApplied = Number(result.SumApplied) + confiscatedTotal ;
                result.InsTotal = Number(result.InsTotal) ;
                result.PaidToDate = Number(result.PaidToDate) ;
            }

            return res.status(200).json(result);
        }
        catch (e) {
            console.log(e)
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

                const grouped = data.reduce((acc, item) => {
                    const date = item.DueDate;

                    if (!acc[date]) {
                        acc[date] = {
                            DueDate: date,
                            SumApplied: 0,
                            InsTotal: 0,
                            PaidToDate: 0,
                        };
                    }

                    acc[date].SumApplied += Number(item.SumApplied ?? 0);
                    acc[date].InsTotal   += Number(item.InsTotal ?? 0);
                    acc[date].PaidToDate += Number(item.PaidToDate ?? 0);

                    return acc;
                }, {});

                const result = Object.values(grouped);

                data = result

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

            const grouped = data.reduce((acc, item) => {
                const date = item.DueDate;

                if (!acc[date]) {
                    acc[date] = {
                        DueDate: date,
                        SumApplied: 0,
                        InsTotal: 0,
                        PaidToDate: 0,
                    };
                }

                acc[date].SumApplied += Number(item.SumApplied ?? 0);
                acc[date].InsTotal   += Number(item.InsTotal ?? 0);
                acc[date].PaidToDate += Number(item.PaidToDate ?? 0);

                return acc;
            }, {});

            const result = Object.values(grouped);

            data = result

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
            console.log(e)
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
                        $gte: moment(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment(endDate, 'YYYY.MM.DD').endOf('day').toDate(),
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

                        item.SumApplied = Number(item.SumApplied);
                        item.InsTotal = Number(item.InsTotal);
                        item.PaidToDate = Number(item.PaidToDate);

                        if(item.PaidToDate > item.SumApplied){
                            let n = item.PaidToDate - item.SumApplied;
                            item.InsTotal = item.InsTotal - n + Confiscated;
                            item.SumApplied = Number(item.SumApplied) + Confiscated;
                            item.PaidToDate = item.SumApplied;
                        }
                        else{
                            item.SumApplied = Number(item.SumApplied) + Confiscated ;
                            item.InsTotal = Number(item.InsTotal) + Confiscated ;
                            item.PaidToDate = Number(item.PaidToDate) ;
                        }


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
                    SumApplied: result.SumApplied ,
                    PaidToDate: result.PaidToDate ,
                    InsTotal: result.InsTotal,
                }


                if(result.PaidToDate > result.SumApplied){
                    result.SumApplied = Number(result.SumApplied) + result.Confiscated;
                    result.PaidToDate = result.SumApplied;
                }
                else{
                    result.SumApplied = Number(result.SumApplied) + result.Confiscated ;
                    result.InsTotal = Number(result.InsTotal) ;
                    result.PaidToDate = Number(result.PaidToDate) ;
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
                const file = files.image[0];
                imagePath = file.filename;
            }

            if (hasAudio) {
                audioPath = {
                    url: files.audio[0].filename,
                    duration: get(req,'body.audioDuration', 0),
                };
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
            const comments = await CommentModel.find(filter).sort({ created_at: 1 }).lean();

            return res.status(200).json(
                comments.map((el) => {
                    const audioUrl = el?.Audio?.url ? `images/${el.Audio.url}` : null;
                    const imageUrl = el?.Image ? `images/${el.Image}` : null; // image field nomi sizda qanday bo'lsa

                    return {
                        ...el,

                        ...(audioUrl ? { Audio: { ...(el.Audio ?? {}), url: audioUrl } } : {Audio: null}),
                        ...(imageUrl ? { Image: imageUrl } : {Image:null}), // image bor bo'lsa qaytadi, bo'lmasa umuman yo'q
                    };
                })
            );
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

            const getFilename = (value) => {
                if (!value) return null;

                if (typeof value === 'string') return value;

                if (typeof value === 'object' && value.url) return value.url;

                return null;
            };

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

                const oldImage = getFilename(existing.Image);
                const oldAudio = getFilename(existing.Audio);

                if (oldImage) {
                    await fsPromises.unlink(path.join(uploadsDir, oldImage)).catch(() => {});
                }
                if (oldAudio) {
                    await fsPromises.unlink(path.join(uploadsDir, oldAudio)).catch(() => {});
                }
            }


            if (hasImage) {
                const file = files.image[0];

                const oldImage = getFilename(existing.Image);
                const oldAudio = getFilename(existing.Audio);

                if (oldImage) {
                    await fsPromises.unlink(path.join(file.destination, oldImage)).catch(() => {});
                }
                if (oldAudio) {
                    await fsPromises.unlink(path.join(file.destination, oldAudio)).catch(() => {});
                }

                updatePayload.Image = file.filename;
                updatePayload.Audio = null;
                updatePayload.Comments = null;
            }
            if (hasAudio) {
                const file = files.audio[0];

                const oldImage = getFilename(existing.Image);
                const oldAudio = getFilename(existing.Audio);

                if (oldAudio) {
                    await fsPromises.unlink(path.join(file.destination, oldAudio)).catch(() => {});
                }
                if (oldImage) {
                    await fsPromises.unlink(path.join(file.destination, oldImage)).catch(() => {});
                }

                updatePayload.Audio = {
                    url: file.filename,
                    duration: get(req, 'body.audioDuration', 0),
                };
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

            const uploadsDir = path.join(process.cwd(), 'uploads');

            // Rasmni o‘chirish
            if (deleted.Image) {
                const imagePath = path.join(uploadsDir, deleted.Image);
                await fs.unlink(imagePath).catch(() => {});
            }

            // Audio faylni o‘chirish
            if (deleted.Audio?.url) {
                const audioPath = path.join(uploadsDir, deleted.Audio.url);
                await fs.unlink(audioPath).catch(() => {});
            }

            return res.status(200).json({
                message: 'Comment deleted successfully'
            });
        } catch (e) {
            console.log(e)
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

            const imageEntries = [];

            for (const file of files) {
                imageEntries.push({
                    _id: uuidv4(),
                    image: file.filename,
                    mimetype: file.mimetype,
                    originalName: file.originalname,
                });
            }

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
                    images: imageEntries,
                });
            }

            return res.status(201).send({
                images: imageEntries.map(e => ({
                    _id: e._id,
                    image: e.image,
                })),
                DocEntry,
                InstlmntID,
            });
        } catch (e) {
            console.error(e);
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
                    message: "Missing required fields: DueDate"
                });
            }

            console.log(req.body)
            // === VALIDATOR: Sana + soat (HH:00) bo‘lishi shart ===
            function validateDateTime(dateTimeStr) {
                if (!dateTimeStr) return null;

                const normalMatch = dateTimeStr.match(/^(\d{4}\.\d{2}\.\d{2}) (\d{2}):(\d{2})$/);
                if (!normalMatch) return null;

                const [_, datePart, hour, minute] = normalMatch;

                if (minute !== "00") {
                    throw new Error("Minutes must be 00. Example: 2025.11.17 16:00");
                }

                const datePartISO = datePart.replace(/\./g, '-'); // 2025.11.19 → 2025-11-19

                // 📌 MUHIM: Asia/Tashkent timezone deb qabul qilish!
                const m = moment.tz(`${datePartISO} ${hour}:${minute}`, "YYYY-MM-DD HH:mm", "Asia/Tashkent");

                if (!m.isValid()) {
                    throw new Error("Invalid date format");
                }

                return m.toDate();  // ← TO‘G‘RI UTC qiymat bo‘ladi
            }

            // === Validate newDueDate ===
            let validatedNewDueDate = null;
            if (newDueDate) {
                try {
                    validatedNewDueDate = validateDateTime(newDueDate);
                } catch (err) {
                    return res.status(400).json({
                        message: err.message,
                        location: "invalid_datetime_format",
                    });
                }
            }

            // === Find or Create Invoice ===
            let invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (invoice) {
                // Update existing
                if (slpCode) {
                    invoice.SlpCode = slpCode;
                    invoice.CardCode = CardCode;
                    invoice.DueDate = parseLocalDateString(DueDate);
                }
                if (validatedNewDueDate) {

                    invoice.newDueDate = validatedNewDueDate;
                    invoice.notificationSent = false;
                }

                if (Phone1) invoice.Phone1 = Phone1;
                if (Phone2) invoice.Phone2 = Phone2;

                await invoice.save();
            } else {
                // Create new
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    CardCode,
                    SlpCode: slpCode || '',
                    DueDate: parseLocalDateString(DueDate),
                    newDueDate: validatedNewDueDate,
                    Phone1,
                    Phone2,
                    notificationSent: false
                });
            }

            return res.status(200).json({
                message: invoice ? "Invoice updated successfully." : "Invoice created successfully.",
                invoiceId: invoice._id,
                DocEntry,
                InstlmntID,
                newDueDate: validatedNewDueDate,
            });

        } catch (e) {
            console.log(e)
            next(e);
        }
    };

    map = async (req, res, next) => {
        try {
            const { cardCode } = req.params;
            const { lat, long } = req.body;

            if(!lat || !long) {
                return res.status(400).json({
                    message: 'lat and long are required.',
                });
            }

            if(lat?.length > 100 || long?.length > 100) {
                return res.status(400).json({
                    message: 'lat and long must be less than 100 characters.',
                });
            }

            if (!cardCode || !lat || !long) {
                return res.status(400).json({
                    message: 'cardCode, lat, and long are required.',
                });
            }

            let user = await UserModel.findOne({ CardCode: cardCode });

            if (user) {
                user.lat = lat;
                user.long = long;
                await user.save();
            } else {
                user = await UserModel.create({
                    CardCode: cardCode,
                    lat: lat,
                    long: long,
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
                    phoneConfiscated: !!phoneConfiscated,
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
                invoice.partial = !!partial;
                await invoice.save();

            } else {
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    DueDate: parseLocalDateString(DueDate),
                    partial: !!partial,

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

    addChat = async (req, res, next) => {
        try {
            const { id } = req.params;
            const { Comments } = req.body;
            const userId = req.user.SlpCode;

            if (!Comments || Comments.trim().length === 0) {
                return res.status(400).json({ message: "Message cannot be empty" });
            }

            if(Comments.trim().length >= 500) {
                return res.status(400).json({ message: "Message is too long. Maximum length is 500 characters." });
            }


            const lead = await LeadModel.findById(id);
            if (!lead) return res.status(404).json({ message: "Lead not found" });

            const chat = await LeadChat.create({
                leadId: id,
                createdBy: userId,
                message:Comments,
            });

            return res.status(201).json({
                message: "Chat created",
                data: chat,
            });
        } catch (err) {
            next(err);
        }
    };

    getChatRecording = async (req, res, next) => {
        try {
            const { uuid } = req.params;

            const dl = await pbxClient.getDownloadUrl(uuid);
            const onlineUrl =
                typeof dl === "string"
                    ? dl
                    : (typeof dl?.data === "string" ? dl.data : dl?.data?.url || dl?.url);

            if (!onlineUrl) return res.status(404).json({ message: "Recording url not found" });

            const r = await axios.get(onlineUrl, { responseType: "stream", timeout: 60000 });

            res.setHeader("Content-Type", r.headers["content-type"] || "audio/mpeg");
            res.setHeader("Cache-Control", "private, max-age=300");

            r.data.pipe(res);
        } catch (err) {
            next(err);
        }
    };

    getChats = async (req, res, next) => {
        try {
            const { id } = req.params;
            let { page = 1, limit = 20, includeDeleted = "false" } = req.query;

            page = Number(page);
            limit = Number(limit);
            if (!Number.isFinite(page) || page < 1) page = 1;
            if (!Number.isFinite(limit) || limit < 1) limit = 20;
            if (limit > 100) limit = 100;

            const lead = await LeadModel.findById(id).select("_id").lean();
            if (!lead) return res.status(404).json({ message: "Lead not found" });

            await syncLeadPbxChats({ pbxClient, leadId: id });

            const userRole = req.user?.U_role;
            const isAdmin = userRole === "Admin";
            const wantIncludeDeleted = String(includeDeleted).toLowerCase() === "true";

            const filter = { leadId: id };
            if (!isAdmin || !wantIncludeDeleted) filter.isDeleted = { $ne: true };

            const skip = (page - 1) * limit;

            const [items, total] = await Promise.all([
                LeadChat.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
                LeadChat.countDocuments(filter),
            ]);
            return res.json({
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                data: items.map((item) => {
                    const audioUrl = item?.pbx?.uuid
                        ? `audio/${id}/chats/recordings/${item.pbx.uuid}.mp3`
                        : (item?.Audio?.url ?? null);

                    return {
                        ...item,
                        Comments: item.message,
                        SlpCode: item.createdBy,
                        Image:null,
                        ...(audioUrl
                            ? {
                                Audio: {
                                    duration: item?.Audio?.duration ?? null,
                                    url: audioUrl,
                                },
                            }
                            : {Audio: null}),
                    };
                }),
            });
        } catch (err) {
            next(err);
        }
    };


    // getChats = async (req, res, next) => {
    //     try {
    //         const { id } = req.params;
    //         let { page = 1, limit = 20, includeDeleted = 'false' } = req.query;
    //
    //         page = Number(page);
    //         limit = Number(limit);
    //
    //         if (!Number.isFinite(page) || page < 1) page = 1;
    //         if (!Number.isFinite(limit) || limit < 1) limit = 20;
    //         if (limit > 100) limit = 100;
    //
    //         const lead = await LeadModel.findById(id).select('_id').lean();
    //         if (!lead) return res.status(404).json({ message: 'Lead not found' });
    //
    //         const userRole = req.user?.U_role;
    //         const isAdmin = userRole === 'Admin';
    //         const wantIncludeDeleted = String(includeDeleted).toLowerCase() === 'true';
    //
    //         const filter = { leadId: id };
    //
    //         // Admin bo‘lmasa — o‘chirilganlarni ko‘rsatmaymiz
    //         // Admin bo‘lsa ham default: ko‘rsatmaymiz (faqat includeDeleted=true bo‘lsa)
    //         if (!isAdmin || !wantIncludeDeleted) {
    //             filter.isDeleted = { $ne: true };
    //         }
    //
    //         const skip = (page - 1) * limit;
    //
    //         const [items, total] = await Promise.all([
    //             LeadChat.find(filter)
    //                 .sort({ createdAt: 1 })
    //                 .skip(skip)
    //                 .limit(limit)
    //                 .lean(),
    //             LeadChat.countDocuments(filter),
    //         ]);
    //
    //         return res.json({
    //             page,
    //             limit,
    //             total,
    //             totalPages: Math.ceil(total / limit),
    //             data: items.map((item) => ({
    //                 ...item,
    //                 Comments: item.message, // sizda "Comments" kerak bo‘lsa
    //                 SlpCode: item.createdBy,
    //                 // xohlasangiz deleted fieldlarni ham qaytaring:
    //                 // isDeleted: item.isDeleted,
    //                 // deletedAt: item.deletedAt,
    //                 // deletedBy: item.deletedBy,
    //             })),
    //         });
    //     } catch (err) {
    //         next(err);
    //     }
    // };

    updateChat = async (req, res, next) => {
        try {
            const { chatId } = req.params;
            const { Comments } = req.body;
            const userId = req.user.SlpCode;
            const userRole = req.user.U_role;

            if (!Comments || Comments.trim() === "") {
                return res.status(400).json({ message: "Message cannot be empty" });
            }

            if(Comments.trim().length >= 500) {
                return res.status(400).json({ message: "Message is too long. Maximum length is 500 characters." });
            }

            const chat = await LeadChat.findById(chatId);
            if (!chat) return res.status(404).json({ message: "Chat not found" });

            if (String(chat.createdBy) !== String(userId) && userRole !== "Admin") {
                return res.status(403).json({ message: "Access denied" });
            }

            chat.message = Comments;
            await chat.save();

            return res.json({ message: "Chat updated", data: chat });
        } catch (err) {
            next(err);
        }
    };

    deleteChat = async (req, res, next) => {
        try {
            const { chatId } = req.params;

            const userId = Number(req.user.SlpCode);
            const userRole = req.user.U_role; // "Admin" bo‘lsa bypass

            const chat = await LeadChat.findOne({ _id: chatId, isDeleted: { $ne: true } });
            if (!chat) return res.status(404).json({ message: 'Chat not found' });

            const isOwner = Number(chat.createdBy) === userId;
            const isAdmin = userRole === 'Admin';

            if (!isOwner && !isAdmin) {
                return res.status(403).json({ message: 'Access denied' });
            }

            chat.isDeleted = true;
            chat.deletedAt = new Date();
            chat.deletedBy = userId;
            chat.deletedByRole = userRole;

            await chat.save();

            return res.json({ message: 'Chat deleted' });
        } catch (err) {
            next(err);
        }
    };

}

module.exports = new b1HANA();


