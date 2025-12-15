const Axios = require("axios");
const https = require("https");
const { get } = require("lodash");
const LeadModel = require('../models/lead-model');
const moment = require('moment');
const { getSession, saveSession } = require("../helpers");
const { api_params, api, db} = require("../config");
const { execute } = require("../services/dbService");

require('dotenv').config();


class b1SL {
    constructor() {
        this.api = api;
    }

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

        let body = {
            "Currency": "UZS",
        }

        if (Phone1) {
            body = {...body, Phone1 }
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
        const rand = String.fromCharCode(65 + Math.floor(Math.random() * 26));
        const CardCode = `BP${moment().format('YYMMDDHHmmss')}${rand}`;

        let body = { CardCode, CardName , "Currency": "UZS", };
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

    buildBatchInvoiceAndPayment(invoiceBody, paymentBody) {
        const batchId = `batch_${crypto.randomUUID()}`;
        const changeSetId = `changeset_${crypto.randomUUID()}`;

        return {
            batchId,
            payload:
`--${batchId}
Content-Type: multipart/mixed;boundary=${changeSetId}
                    
--${changeSetId}
Content-Type: application/http
Content-Transfer-Encoding: binary
Content-ID: 1
                    
POST /ServiceLayer/b1s/v1/Invoices HTTP/1.1
Content-Type: application/json
                    
${JSON.stringify(invoiceBody,null,4)}
                    
--${changeSetId}
Content-Type: application/http
Content-Transfer-Encoding: binary
Content-ID: 2
                    
POST /ServiceLayer/b1s/v1/IncomingPayments HTTP/1.1
Content-Type: application/json
                    
${JSON.stringify(paymentBody,null,4).replace('"DocEntry": 0', '"DocEntry":$1')}
                    
--${changeSetId}--
--${batchId}--`
        };
    }

    parseSapBatchResponse(raw) {
        const blocks = raw.split("HTTP/1.1").slice(1);

        let invoice = null;
        let payment = null;
        let errors = [];

        for (const block of blocks) {
            const status = Number(block.substring(0, 3));

            const jsonMatch = block.match(/\{[\s\S]*\}/);
            const json = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

            if (status >= 400) {
                errors.push(json?.error?.message?.value || "Unknown SAP error");
                continue;
            }

            if (json?.DocEntry && !invoice) {
                invoice = {
                    DocEntry: json.DocEntry,
                    DocNum: json.DocNum,
                };
                continue;
            }

            if (json?.DocEntry && invoice && !payment) {
                payment = {
                    DocEntry: json.DocEntry
                };
            }
        }

        return {
            ok: errors.length === 0,
            invoice,
            payment,
            errors
        };
    }

    createInvoiceAndPayment = async (req, res, next) => {
        try {

            if(!req.user.U_branch){
                return res.status(400).json({
                    status: false,
                    message: "Siz Sotuvchi emassiz"
                });
            }
            const leadId = req.body.leadId;
            delete req.body.leadId;
            delete req.body.selectedDevices;

            if (!leadId) {
                return res.status(400).json({
                    status: false,
                    message: "leadId is required"
                });
            }

            const sapInvoiceQuery = `
                SELECT
                    T0."DocEntry",
                    T0."DocNum",
                    T0."U_leadId",
                    T0."CANCELED"
                FROM ${db}."OINV" T0
                WHERE
                    T0."CANCELED" = 'N'
                  AND T0."U_leadId" = '${leadId}'
            `;

            const existingInvoices = await execute(sapInvoiceQuery);
            if (existingInvoices?.length > 0) {
                return res.status(400).json({
                    status: false,
                    message: "This lead already has an invoice in SAP",
                    DocEntry: existingInvoices[0].DocEntry,
                    DocNum: existingInvoices[0].DocNum
                });
            }

            let body = { ...req.body };

            let createdBP = false;
            if (!body.CardCode) {
                const clientPhone = body.clientPhone;
                if (!clientPhone) {
                    return res.status(400).json({
                        status: false,
                        message: "CardCode missing and clientPhone required",
                    });
                }

                const bp = await this.createBusinessPartner({
                    Phone1: clientPhone,
                    Phone2: "",
                    CardName: body.clientName || "No Name"
                });

                if (!bp?.CardCode) {
                    return res.status(400).json({
                        status: false,
                        message: bp?.message || "Failed to create Business Partner"
                    });
                }

                createdBP = true;
                body.CardCode = bp.CardCode;
                delete body.clientPhone;
                delete body.clientName;
                delete body.jshshir;
                delete body.passportId;
                delete body.clientAddress;
                delete body.monthlyLimit;
                delete body.sellerName;
            }
            else{
                await this.updateBusinessPartner({CardCode:body.CardCode})
                delete body.clientPhone;
                delete body.clientName;
                delete body.jshshir;
                delete body.passportId;
                delete body.clientAddress;
                delete body.monthlyLimit;
                delete body.sellerName;
            }

            let obj = {
                "1":"5010",
                "2":"5040",
                "3":"5060"
            }

            const paymentBody = {
                CardCode: body.CardCode,
                DocCurrency: "UZS",
                CashSum: (req.body.CashSum || 0)  ,
                CashAccount: body.paymentType === 'Card' ? "5020" : obj[req.user.U_branch],
                DocRate: req.body.DocRate || 11990,
                PaymentInvoices: [
                    {
                        DocEntry: 0,
                        SumApplied: req.body.CashSum / req.body.DocRate ,
                        "DocRate": req.body.DocRate || 11990,
                        "InstallmentId": 1
                    }
                ]
            };

            console.log("SAP payment body:", paymentBody);

            delete body.DocRate;
            delete body.CashSum;
            delete body.paymentType;

            const { batchId, payload } = this.buildBatchInvoiceAndPayment(body, paymentBody);

            console.log("SAP batch payload:", payload);
            //
            // return res.status(201).json({
            //     status: true,
            //     message: "Test",
            // });

            const axiosInstance = Axios.create({
                baseURL: `${this.api}`,
                timeout: 30000,
                headers: {
                    'Content-Type': `multipart/mixed;boundary=${batchId}`,
                    'Cookie':
                        get(getSession(), 'Cookie[0]', '') +
                        get(getSession(), 'Cookie[1]', ''),
                    'SessionId': get(getSession(), 'SessionId', '')
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            });

            const response = await axiosInstance.post(`/$batch`, payload);

            console.log("SAP batch response:", response.data);

            const parsed = this.parseSapBatchResponse(response.data);

            if (!parsed.ok) {
                return res.status(400).json({
                    status: false,
                    message: "SAP batch error",
                    errors: parsed.errors
                });
            }

            if (!parsed.invoice) {
                return res.status(400).json({
                    status: false,
                    message: `Invoice was not created in SAP ${response.data}`
                });
            }

            if (!parsed.payment) {
                return res.status(400).json({
                    status: false,
                    message: "Incoming Payment was not created in SAP"
                });
            }

            const invoiceDocEntry = parsed.invoice.DocEntry;
            const invoiceDocNum = parsed.invoice.DocNum;

            console.log("Invoice created:", parsed.invoice);
            console.log("Payment created:", parsed.payment);

            if (!invoiceDocEntry) {
                return res.status(400).json({
                    status: false,
                    message: "SAP Batch Error: Invoice not created",
                    raw: response.data
                });
            }

            // 7. Update lead
            await LeadModel.updateOne(
                { _id: leadId },
                {
                    $set: {
                        invoiceCreated: true,
                        invoiceDocEntry,
                        invoiceDocNum,
                        invoiceCreatedAt: new Date(),
                        paymentCreated: true,
                        paymentCreatedAt: new Date(),
                        ...(createdBP && { cardCode: body.CardCode })
                    }
                }
            );

            return res.status(201).json({
                status: true,
                invoiceDocEntry,
                invoiceDocNum,
                raw: response.data
            });

        } catch (err) {
            console.log("Batch SAP Error:", err?.response?.data || err);

            if (get(err, 'response.status') == 401) {
                const token = await this.auth();
                if (token.status) return this.createInvoiceAndPayment(req, res, next);
                return res.status(401).json({ status: false, message: token.message });
            }

            const sapErr = get(err, 'response.data.error.message.value', "SAP error");
            return res.status(400).json({
                status: false,
                message: sapErr
            });
        }
    };

    findOrCreateBusinessPartner = async (phone, cardName) => {
        if (!phone) return null;

        function normalizePhone(input) {
            if (!input) return null;
            let digits = String(input).replace(/\D/g, '');

            if (digits.startsWith('998') && digits.length > 9) {
                digits = digits.slice(3);
            }

            if (digits.length === 10 && digits.startsWith('0')) {
                digits = digits.slice(1);
            }
            return digits;
        }

        const digits = normalizePhone(phone);

        const query = `
        SELECT "CardCode", "CardName", "Phone1", "Phone2"
        FROM ${db}.OCRD
        WHERE "Phone1" LIKE '%${digits}' OR "Phone2" LIKE '%${digits}'
    `;

        console.log("SAP query:", query);

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


