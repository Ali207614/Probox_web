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


ffmpeg.setFfprobePath(ffprobeStatic.path);
require('dotenv').config();


class b1HANA {
    execute = async (sql) => {
        try {
            return dbService.execute(sql);
        } catch (e) {
            throw new Error(e);
        }
    };

    getItems = async (req, res, next) => {
        try {
            const {
                search,
                whsCode,
                limit = 20,
                offset = 0,
                ...filters
            } = req.query;

            const query = DataRepositories.getItems({
                search,
                filters,
                limit,
                offset,
                whsCode
            });


            const rows = await this.execute(query);

            res.json({
                total: rows.length,
                items: rows
            });
        }
        catch (e) {
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

    getItemSeries = async (req, res, next) => {
        try {
            const {
                itemCode,
                whsCode,
            } = req.query;

            if (!whsCode || !itemCode) {
                return next(ApiError.BadRequest('WhsCode/ItemCode is required '));
            }

            const query = DataRepositories.getItemSeries({
                whsCode,
                itemCode,
            });

            const rows = await this.execute(query);

            res.json({
                total: rows.length,
                items: rows
            });
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
                let filter = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: startDateMoment,
                        $lte: endDateMoment
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

                if (paymentStatus?.split(',').includes('paid') || paymentStatus?.split(',').includes('partial')) {
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
                            lat: user.lat || null,
                            long: user.long || null,
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
                    ];
                }
                // aks holda → text qidirish
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

            if (sources?.length) filter.source = { $in: sources };
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
            parseYesNoUnmarked(isBlocked, 'isBlocked');
            parseYesNoUnmarked(meetingHappened, 'meetingHappened');

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
                        { passportId: { $exists: true, $nin: [null, ''] } },
                        { jshshir: { $exists: true, $nin: [null, ''] } },
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
            const rawData = await LeadModel.find(filter)
                .select(
                    '_id paymentScore totalContracts openContracts totalAmount totalPaid overdueDebt maxDelay avgPaymentDelay callCount callCount2 acceptedReason meetingHappened cardCode invoiceCreated invoiceDocEntry invoiceDocNum invoiceCreatedAt isBlocked status jshshir idX branch2 seller n scoring clientName clientPhone source time operator operator2 branch comment meetingConfirmed meetingDate createdAt purchase called answered interested called2 answered2 passportId jshshir2 score mib aliment officialSalary finalLimit finalPercentage'
                )
                .sort({ time: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const data = rawData.map((item) => ({
                n: item.n,
                id: item._id,
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
                status: item.status,
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
                    ? moment(item.meetingDate).format('YYYY.MM.DD')
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

            const startOfDay = moment().startOf('day').toDate();
            const endOfDay = moment().endOf('day').toDate();

            // 📌 PHONE VALIDATION
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

            // 📌 DUPLICATE CHECK (today only)
            const exists = await LeadModel.exists({
                clientPhone: cleanedPhone,
                source,
                createdAt: { $gte: startOfDay, $lte: endOfDay },
            });

            if (exists) {
                return res.status(409).json({
                    message: "Bu lead allaqachon mavjud",
                });
            }

            let operator = operator1 || null;
            if (source !== 'Organika' && !operator) {
                operator = await assignBalancedOperator();
            }

            const n = await generateShortId('PRO');
            const time = new Date();


            const sapRecord = await b1Sl.findOrCreateBusinessPartner(cleanedPhone, clientName);

            const cardCode = sapRecord?.cardCode || null;
            const cardName = sapRecord?.cardName || null;


            let dataObj = {
                n,
                source,
                clientName,
                clientPhone: cleanedPhone,
                branch2: branch2 || null,
                seller: seller || null,
                source2: source2 || null,
                comment: comment || null,
                operator,
                time,
                cardCode,
                cardName,
            };

            if (source === 'Organika') {
                dataObj = {
                    ...dataObj,
                    meetingConfirmed: true,
                    meetingConfirmedDate: new Date(),
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

    mergeInstallments(rows) {
        const map = {};

        for (const r of rows) {
            const key = `${r.DocEntry}_${r.InstlmntID}`;

            if (!map[key]) {
                map[key] = {
                    DocEntry: r.DocEntry,
                    InstlmntID: r.InstlmntID,
                    DueDate: r.DueDate,
                    InsTotal: Number(r.InsTotal),
                    TotalPaid: 0,
                    PaidDate: null
                };
            }

            map[key].TotalPaid += Number(r.SumApplied || 0);

            const paymentDate = r.DocDate ?  new Date(r.DocDate) : new Date();
            if (!map[key].PaidDate || paymentDate > map[key].PaidDate) {
                map[key].PaidDate = paymentDate;
            }
        }

        return Object.values(map);
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


    // calculateLeadPaymentScore = async (cardCode) => {
    //     const sql = DataRepositories.getInstallmentPayments(cardCode);
    //     const rows = await this.execute(sql);
    //
    //
    //     if (!rows || rows.length === 0) return 0;
    //
    //     const installments = this.mergeInstallments(rows);
    //
    //     const score = this.calculateTotalScore(installments);
    //     return score;
    // }


    calculateLeadPaymentScore = async (cardCode) => {
        const sql = DataRepositories.getInstallmentPayments(cardCode);
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
            if (!installmentsMap[key] && r.Canceled !== 'Y') {
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

        for (const inst of filtered) {
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

        return {
            score,
            totalContracts,
            openContracts,
            totalAmount,
            totalPaid,
            overdueDebt,
            maxDelay,
            avgPaymentDelay
        };
    };

    updateLead = async (req, res, next) => {
        try {
            const { id } = req.params;
            const { U_role } = req.user;
            const body = req.body;

            const existingLead = await LeadModel.findById(id).lean();
            if (!existingLead) {
                return res.status(404).json({ message: 'Lead not found' });
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


            if( validData.callCount2 &&  existingLead.callCount2  !== validData.callCount2) {
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

            if (
                (validData.answered === false || existingLead.answered === false) &&
                (Number(validData.callCount) >= 3)
            ) {
                validData.status = 'Closed';
            }



            // === Normalize fields
            if (validData?.clientFullName) {
                validData.clientName = validData.clientFullName;
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
                    const scoringQuery = DataRepositories.getSalesPersons({
                        include: ['Scoring'],
                    });
                    const scoringData = await this.execute(scoringQuery);

                    if (scoringData.length > 0) {
                        const randomIndex = Math.floor(Math.random() * scoringData.length);
                        const selectedScoring = scoringData[randomIndex];
                        validData.scoring = selectedScoring?.SlpCode || null;
                        const io = req.app.get('io');
                        if (io) io.emit('scoring_lead', { n: existingLead.n,
                            _id:existingLead._id,
                            source:existingLead.source,
                            clientName:existingLead.clientName ,
                            time: existingLead.time,
                            clientPhone :existingLead.clientPhone ,
                            SlpCode: validData.scoring
                        });
                    } else {
                        console.warn('No Scoring operator found');
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
                    console.log(sapResult ,' bu spaResult')
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
                        console.log(`SAP: No record found for ${jshshir || passport || phone}`);
                    }
                } catch (sapErr) {
                    console.warn('SAP check failed:', sapErr.message);
                }
            }

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
                let filter = {
                    SlpCode: { $in: slpCodeArray },
                    DueDate: {
                        $gte: moment(startDate, 'YYYY.MM.DD').startOf('day').toDate(),
                        $lte: moment(endDate, 'YYYY.MM.DD').endOf('day').toDate(),
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

                if(result.PaidToDate > result.SumApplied){
                    let n = result.PaidToDate - result.SumApplied;
                    result.InsTotal = result.InsTotal - n + confiscatedTotal;
                    result.SumApplied = Number(result.SumApplied) + confiscatedTotal;
                    result.PaidToDate = result.SumApplied;
                }
                else{
                    result.SumApplied = Number(result.SumApplied) + confiscatedTotal ;
                    result.InsTotal = Number(result.InsTotal) + confiscatedTotal ;
                    result.PaidToDate = Number(result.PaidToDate) ;
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
            const query = await DataRepositories.getAnalytics({ startDate, endDate, invoices: invoiceConfiscated, phoneConfiscated: 'true' })

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

    getChats = async (req, res, next) => {
        try {
            const { id } = req.params;
            let { page = 1, limit = 20 } = req.query;

            page = Number(page);
            limit = Number(limit);

            const lead = await LeadModel.findById(id);
            if (!lead) return res.status(404).json({ message: "Lead not found" });

            const skip = (page - 1) * limit;

            const [items, total] = await Promise.all([
                LeadChat.find({ leadId: id })
                    .sort({ createdAt: 1 })
                    .skip(skip)
                    .limit(limit)
                    .lean()
                ,
                LeadChat.countDocuments({ leadId: id })
            ]);

            return res.json({
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                data: items.map(item => ({ ...item,Comments: item.message, SlpCode: item.createdBy })),
            });

        } catch (err) {
            next(err);
        }
    };

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
            const userId = req.user.SlpCode;
            const userRole = req.user.U_role;

            const chat = await LeadChat.findById(chatId);
            if (!chat) return res.status(404).json({ message: "Chat not found" });

            if (String(chat.createdBy) !== String(userId) && userRole !== "Admin") {
                return res.status(403).json({ message: "Access denied" });
            }

            await chat.deleteOne();

            return res.json({ message: "Chat deleted" });
        } catch (err) {
            next(err);
        }
    };
}

module.exports = new b1HANA();


