const Axios = require("axios");
const https = require("https");
const { get } = require("lodash");
let dbService = require('../services/dbService')

const moment = require('moment');
const { getSession, saveSession } = require("../helpers");
const { api_params, api } = require("../config");

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

        const body = req.body;

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

            // ✔ SUCCESS → lead update qilish
            if (leadId) {
                await LeadModel.updateOne(
                    { _id: leadId },
                    {
                        $set: {
                            invoiceCreated: true,
                            invoiceDocEntry: data?.DocEntry || null,
                            invoiceDocNum: data?.DocNum || null,
                            invoiceCreatedAt: new Date(),
                        },
                    }
                );
            }

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

}

module.exports = new b1SL();


