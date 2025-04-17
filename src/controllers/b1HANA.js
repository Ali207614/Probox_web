const { get } = require("lodash");
const tokenService = require('../services/tokenService');
const { v4: uuidv4, validate } = require('uuid');
const path = require('path')
const fs = require('fs')
let dbService = require('../services/dbService')

const DataRepositories = require("../repositories/dataRepositories");
const ApiError = require("../exceptions/api-error");
const InvoiceModel = require("../models/invoice-model");
const { convertToISOFormat, shuffleArray, checkFileType } = require("../helpers");

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
            let { startDate, endDate, page = 1, limit = 20, slpCode, paymentStatus, cardCode, serial, phone } = req.query

            page = parseInt(page, 10);
            limit = parseInt(limit, 10);

            const skip = (page - 1) * limit;

            if (!startDate || !endDate) {
                return res.status(404).json({ error: 'startDate and endDate are required' });
            }

            if (Number(slpCode)) {

                const filter = {
                    SlpCode: slpCode,
                    DueDate: {
                        $gte: new Date(startDate),
                        $lte: new Date(endDate),
                    }
                };

                const invoicesModel = await InvoiceModel.find(filter)
                    .skip(skip)
                    .limit(limit)

                if (invoicesModel.length == 0) {
                    return res.status(200).json({
                        total: 0,
                        page,
                        limit,
                        totalPages: Math.ceil(0 / limit),
                        data: []
                    });
                }

                const query = await DataRepositories.getDistributionInvoice({ startDate, endDate, limit, offset: skip, paymentStatus, cardCode, serial, phone, invoices: invoicesModel });

                let invoices = await this.execute(query);
                let total = get(invoices, '[0].Count', 0) || 0

                return res.status(200).json({
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                    data: invoices.map(el => {
                        return { ...el, SlpCode: slpCode, Images: invoicesModel.find(item => item.DocEntry == el.DocEntry && item.InstlmntID == el.InstlmntID)?.images || [] }
                    })
                });
            }

            const query = await DataRepositories.getInvoice({ startDate, endDate, limit, offset: skip, paymentStatus, cardCode, serial, phone });
            let invoices = await this.execute(query);

            const invoicesModel = await InvoiceModel.find({
                DocEntry: {
                    $in: [...new Set(invoices.map(el => el.DocEntry))],
                }
            });

            let total = get(invoices, '[0].Count', 0) || 0

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data: invoices.map(el => {
                    return {
                        ...el,
                        SlpCode: invoicesModel.find(item => item.DocEntry == el.DocEntry && item.InstlmntID == el.InstlmntID)?.SlpCode || null,
                        Images: invoicesModel.find(item => item.DocEntry == el.DocEntry && item.InstlmntID == el.InstlmntID)?.images || []
                    }
                })
            });
        }
        catch (e) {
            next(e)
        }
    };

    search = async (req, res, next) => {
        try {
            let { startDate, endDate, page = 1, limit = 50, slpCode, paymentStatus, search, phone } = req.query

            page = parseInt(page, 10);
            limit = parseInt(limit, 10);

            const skip = (page - 1) * limit;

            if (Number(slpCode)) {

                const invoicesModel = await InvoiceModel.find({
                    SlpCode: slpCode,
                    DueDate: {
                        $gte: new Date(startDate),
                        $lte: new Date(endDate),
                    }
                });


                if (invoicesModel.length == 0) {
                    return res.status(200).json({
                        total: 0,
                        page,
                        limit,
                        totalPages: Math.ceil(0 / limit),
                        data: []
                    });
                }

                const query = await DataRepositories.getInvoiceSearchBPorSeriaDistribution({ startDate, endDate, limit, offset: skip, paymentStatus, search, phone, invoices: invoicesModel });

                let invoices = await this.execute(query);
                let total = get(invoices, '[0].Count', 0) || 0

                return res.status(200).json({
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                    data: invoices.map(el => {
                        return { ...el, SlpCode: slpCode }
                    })
                });
            }

            if (!startDate || !endDate) {
                return res.status(404).json({ error: 'startDate and endDate are required' });
            }

            const query = await DataRepositories.getInvoiceSearchBPorSeria({ startDate, endDate, limit, offset: skip, paymentStatus, search, phone });

            let invoices = await this.execute(query);

            const invoicesModel = await InvoiceModel.find({
                DocEntry: {
                    $in: [...new Set(invoices.map(el => el.DocEntry))],
                }
            });

            let total = get(invoices, '[0].Count', 0) || 0

            return res.status(200).json({
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
                data: invoices.map(el => {
                    return { ...el, SlpCode: invoicesModel.find(item => item.DocEntry == el.DocEntry && item.InstlmntID == el.InstlmntID)?.SlpCode || null }
                })
            });

        } catch (e) {
            next(e)
        }
    };

    executors = async (req, res, next) => {
        try {
            const query = await DataRepositories.getSalesPersons();
            let data = await this.execute(query);
            let total = data.length

            return res.status(200).json({
                total,
                data
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
                        newResult.push({ DueDate: data[i].DueDate, SlpName: first.SlpName, InstlmntID: data[i].InstlmntID, DocEntry: data[i].DocEntry, SlpCode: first.SlpCode, CardCode: data[i].CardCode, ItemName: data[i].Dscription })
                    }
                }
                else {
                    let first = SalesList[count]
                    newResult.push({ DueDate: data[i].DueDate, SlpName: first?.SlpName, InstlmntID: data[i].InstlmntID, DocEntry: data[i].DocEntry, SlpCode: first?.SlpCode, CardCode: data[i].CardCode, ItemName: data[i].Dscription })
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
                    PaidToDate: list?.length ? list.reduce((a, b) => a + Number(b?.SumApplied || 0), 0) : 0,
                    InsTotal: get(list, `[0].InsTotal`, 0),
                    PaysList: list.map(item => ({ SumApplied: item.SumApplied, AcctName: item.AcctName, DocDate: item.DocDate, CashAcct: item.CashAcct, CheckAcct: item.CheckAcct }))
                }
            })
            return res.status(200).json(result)
        }
        catch (e) {
            next(e)
        }
    }




    uploadImage = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID } = req.params;
            const file = req.file;
            if (!file) {
                return res.status(400).send('Error: No file uploaded.');
            }

            const imageEntry = {
                _id: uuidv4(),
                image: file.filename // multer filename avtomatik qaytadi
            };

            let invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (invoice) {
                if (!Array.isArray(invoice.images)) {
                    invoice.images = [];
                }
                invoice.images.push(imageEntry);
                await invoice.save();
            } else {
                invoice = await InvoiceModel.create({
                    DocEntry,
                    InstlmntID,
                    images: [imageEntry]
                });
            }

            return res.status(201).send({
                image: file.filename,
                DocEntry,
                InstlmntID,
                oldName: file.originalname,
                _id: get(imageEntry, '_id', 1)
            });
        } catch (e) {
            next(e);
        }
    };


    deleteImage = async (req, res, next) => {
        try {
            const { DocEntry, InstlmntID, ImageId } = req.params;

            const invoice = await InvoiceModel.findOne({ DocEntry, InstlmntID });

            if (!invoice) {
                return res.status(404).send('Invoice not found');
            }

            if (!Array.isArray(invoice.images)) {
                return res.status(400).send('No images found for this invoice');
            }

            // Rasmni topamiz
            const imageIndex = invoice.images.findIndex(img => String(img._id) === String(ImageId));
            console.log(imageIndex)
            if (imageIndex === -1) {
                return res.status(404).send('Image not found');
            }

            const imageFileName = invoice.images[imageIndex].image;

            // MongoDB'dan rasmni o‘chiramiz
            invoice.images.splice(imageIndex, 1);
            await invoice.save();

            // Fayl tizimidan rasmni o‘chiramiz
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
}

module.exports = new b1HANA();


