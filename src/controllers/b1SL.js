const Axios = require("axios");
const https = require("https");
const { get } = require("lodash");
let dbService = require('../services/dbService')

const moment = require('moment');
const { getSession, saveSession } = require("../helpers");
const { api_params, api, db} = require("../config");
const {execute} = require("../services/dbService");

require('dotenv').config();


class b1SL {
    constructor() {
        this.api = api;
    }
    execute = async (sql) => {
        try {
            let data = await dbService.execute(sql);
            return data;
        } catch (e) {
            throw new Error(e);
        }
    };
    auth = async () => {
        let obj = api_params
        const axios = Axios.create({
            baseURL: `${this.api}`,
            timeout: 30000,
            httpsAgent: new https.Agent({
                rejectUnauthorized: false,
            }),
        });
        return axios.post("/Login", obj).then(({ headers, data }) => {
            saveSession({
                'Cookie': get(headers, 'set-cookie', ''),
                'SessionId': get(data, 'SessionId', '')
            })
            return { status: true };
        }).catch(err => {
            return { status: false, message: get(err, 'response.data.error.message.value') }
        });
    }

    postIncomingPayment = async (req, res, next) => {
        let body = req.body
        const axios = Axios.create({
            baseURL: `${this.api}`,
            timeout: 30000,
            headers: {
                'Cookie': get(getSession(), 'Cookie[0]', '') + get(getSession(), 'Cookie[1]', ''),
                'SessionId': get(getSession(), 'SessionId', '')
            },
            httpsAgent: new https.Agent({
                rejectUnauthorized: false,
            }),
        });
        return axios
            .post(`/IncomingPayments`, body)
            .then(async ({ data }) => {
                return res.status(201).json(data)
            })
            .catch(async (err) => {
                if (get(err, 'response.status') == 401) {
                    let token = await this.auth()
                    if (token.status) {
                        return await this.postIncomingPayment(req, res, next)
                    }
                    return res.status(get(err, 'response.status', 400) || 400).json({ status: false, message: token.message })
                } else {
                    return res.status(get(err, 'response.status', 400) || 400).json({ status: false, message: get(err, 'response.data.error.message.value') })
                }
            });
    }

    updateBusinessPartner = async ({ Phone1, Phone2, CardCode }) => {

        let body = {}

        if (Phone1) {
            body = { Phone1 }
        }

        if (Phone2) {
            body = { ...body, Phone1 }
        }

        const axios = Axios.create({
            baseURL: `${this.api}`,
            timeout: 30000,
            headers: {
                'Cookie': get(getSession(), 'Cookie[0]', '') + get(getSession(), 'Cookie[1]', ''),
                'SessionId': get(getSession(), 'SessionId', '')
            },
            httpsAgent: new https.Agent({
                rejectUnauthorized: false,
            }),
        });
        return axios
            .patch(`/BusinessPartners('${CardCode}')`, body)
            .then(async ({ data }) => {
                return data
            })
            .catch(async (err) => {
                if (get(err, 'response.status') == 401) {
                    let token = await this.auth()
                    if (token.status) {
                        return await this.updateBusinessPartner({ Phone1, Phone2, CardCode })
                    }
                    return { status: false, message: token.message }
                } else {
                    return { status: false, message: get(err, 'response.data.error.message.value') }
                }
            });
    }

    createBusinessPartner = async ({ Phone1, Phone2, CardName }) => {
        const rand = String.fromCharCode(65 + Math.floor(Math.random() * 26)); // A–Z
        const CardCode = `BP${moment().format('YYMMDDHHmmss')}${rand}`; // 15 belgi

        let body = { CardCode, CardName };
        if (Phone1) body = { ...body, Phone1 };
        if (Phone2) body = { ...body, Phone2 };

        const axios = Axios.create({
            baseURL: `${this.api}`,
            timeout: 30000,
            headers: {
                'Cookie':
                    get(getSession(), 'Cookie[0]', '') +
                    get(getSession(), 'Cookie[1]', ''),
                'SessionId': get(getSession(), 'SessionId', ''),
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        });

        return axios
            .post(`/BusinessPartners`, body)
            .then(async ({ data }) => data)
            .catch(async (err) => {
                if (get(err, 'response.status') == 401) {
                    const token = await this.auth();
                    if (token.status)
                        return await this.createBusinessPartner({ Phone1, Phone2, CardName });
                    return { status: false, message: token.message };
                } else {
                    console.log(get(err, 'response.data.error.message.value'), ' bu SAP ERROR');
                    return {
                        status: false,
                        message: get(err, 'response.data.error.message.value'),
                    };
                }
            });
    };

    createInvoice = async (req, res, next) => {
        const leadId = req.body.leadId;
        delete req.body.leadId;

        let body = { ...req.body };

        if (!leadId) {
            return {
                status: false,
                message: "leadId is required to create an invoice",
            };
        }

        let createdBP = false;
        let createdCardCode = null;
        let createdCardName = null;

        if (!body.CardCode || body.CardCode === null) {
            const clientPhone = body.clientPhone || body.Phone1 || body.Phone2;

            if (!clientPhone) {
                return {
                    status: false,
                    message: "CardCode is missing and clientPhone is required to create Business Partner",
                };
            }

            const bp = await this.createBusinessPartner({
                Phone1: clientPhone,
                Phone2: '',
                CardName: body.CardName || "No Name"
            });

            if (!bp?.CardCode) {
                return {
                    status: false,
                    message: bp?.message || "Failed to create Business Partner",
                };
            }

            createdBP = true;
            createdCardCode = bp.CardCode;
            createdCardName = body.CardName || "No Name";

            body.CardCode = bp.CardCode;

            delete body.clientPhone;
            delete body.Phone1;
            delete body.Phone2;
        }

        const axiosInstance = Axios.create({
            baseURL: `${this.api}`,
            timeout: 30000,
            headers: {
                'Cookie':
                    get(getSession(), 'Cookie[0]', '') +
                    get(getSession(), 'Cookie[1]', ''),
                'SessionId': get(getSession(), 'SessionId', ''),
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        });

        try {
            const { data } = await axiosInstance.post(`/Invoice`, body);

            const updateData = {
                invoiceCreated: true,
                invoiceDocEntry: data?.DocEntry || null,
                invoiceDocNum: data?.DocNum || null,
                invoiceCreatedAt: new Date(),
            };

            if (createdBP) {
                updateData.cardCode = createdCardCode;
                updateData.cardName = createdCardName;
            }

            await LeadModel.updateOne(
                { _id: leadId },
                { $set: updateData }
            );

            return {
                status: true,
                invoice: data,
            };

        } catch (err) {
            if (get(err, 'response.status') == 401) {
                const token = await this.auth();
                if (token.status) return await this.createInvoice(req, res, next);

                return { status: false, message: token.message };
            }

            console.log(get(err, 'response.data.error.message.value'), ' SAP ERROR');

            return {
                status: false,
                message: get(err, 'response.data.error.message.value'),
            };
        }
    };

    findOrCreateBusinessPartner = async (phone, cardName) => {
        if (!phone) return null;

        const digits = String(phone).replace(/\D/g, "");

        const query = `
        SELECT "CardCode", "CardName", "Phone1", "Phone2"
        FROM ${db}.OCRD
        WHERE "Phone1" LIKE '%${digits}' OR "Phone2" LIKE '%${digits}'
    `;

        try {
            const rows = await execute(query);

            if (rows && rows.length > 0) {
                return {
                    cardCode: rows[0].CardCode,
                    cardName: rows[0].CardName,
                    created: false,
                };
            }
        } catch (err) {
            console.error("SAP search error:", err);
        }

        const bp = await this.createBusinessPartner({
            Phone1: phone,
            Phone2: '',
            CardName: cardName || "No Name",
        });

        if (!bp?.CardCode) {
            console.error("BP create error:", bp?.message);
            return null;
        }

        return {
            cardCode: bp.CardCode,
            cardName: cardName || "No Name",
            created: true,
        };
    }


}

module.exports = new b1SL();


