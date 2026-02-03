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

    normalizePhone = (phone = '') => {
        let p = String(phone).trim();

        // bo'sh joylarni olib tashla
        p = p.replace(/\s+/g, '');

        // faqat raqam qoldir
        p = p.replace(/\D/g, '');

        // agar 998 bilan boshlanmasa → qo‘sh
        if (p.length === 9) {
            p = '998' + p;
        }

        if (p.length === 12 && p.startsWith('998')) {
            return p;
        }

        return null; // yaroqsiz
    };

    findBpByPhoneSql = (phone) => `
    SELECT
        T0."CardCode",
        T0."CardName",
        T0."Currency",
        T0."Phone1",
        T0."Phone2",
        T0."U_jshshir",
        T0."Cellular"
    FROM ${db}.OCRD T0
    WHERE
        T0."Currency" = 'UZS'
        AND (
            REPLACE(REPLACE(REPLACE(T0."Phone1", '+', ''), ' ', ''), '-', '') LIKE '%${phone}%'
            OR
            REPLACE(REPLACE(REPLACE(T0."Phone2", '+', ''), ' ', ''), '-', '') LIKE '%${phone}%'
        )
    LIMIT 1
`;

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

    updateBusinessPartner = async ({ Phone1, Phone2, CardCode , CardName }) => {

        let body = {
            "Currency": "UZS",
        }

        if (Phone1) {
            body = {...body, Phone1 }
        }

        if (Phone2) {
            body = { ...body, Phone1 }
        }

        if(CardName){
            body = { ...body, CardName }
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

    createBusinessPartner = async ({ Phone1, Phone2, CardName , U_jshshir, Cellular }) => {
        const rand = String.fromCharCode(65 + Math.floor(Math.random() * 26));
        const CardCode = `BP${moment().format('YYMMDDHHmmss')}${rand}`;

        let body = { CardCode, CardName , "Currency": "UZS", };
        if (Phone1) body = { ...body, Phone1 };
        if (Phone2) body = { ...body, Phone2 };
        if (U_jshshir) body = { ...body, U_jshshir };
        if (Cellular) body = { ...body, Cellular };

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

    buildBatchInvoiceAndPayment(invoiceBody, s) {
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

            const rawPhone = body.clientPhone;
            const normalizedPhone = this.normalizePhone(rawPhone);

            if (!normalizedPhone) {
                return res.status(400).json({
                    status: false,
                    message: 'Invalid client phone number'
                });
            }

            const bpRows = await execute(this.findBpByPhoneSql(normalizedPhone));

            let cardCode;
            let createdBP = false;

            if (bpRows?.length) {
                // ✅ BOR BP
                cardCode = bpRows[0].CardCode;
            } else {
                // ❌ YO‘Q → CREATE
                const bp = await this.createBusinessPartner({
                    CardName: body.clientName || 'No Name',
                    Phone1: normalizedPhone,
                    Currency: 'UZS',
                    U_jshshir: body.jshshir,
                    Cellular:body.passportId
                });

                if (!bp?.CardCode) {
                    return res.status(400).json({
                        status: false,
                        message: bp?.message || 'Failed to create Business Partner'
                    });
                }

                cardCode = bp.CardCode;
                createdBP = true;
            }

            body.CardCode = cardCode;

            delete body.clientPhone;
            delete body.clientName;
            delete body.jshshir;
            delete body.passportId;
            delete body.clientAddress;
            delete body.monthlyLimit;
            delete body.sellerName;

            let obj = {
                "1":"5040",
                "2":"5010",
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
        const digits = this.normalizePhone(phone);
        console.log("digits:", digits);

        if (!digits) {
            return res.status(400).json({
                status: false,
                message: 'Invalid client phone number'
            });
        }

        const bpRows = await execute(this.findBpByPhoneSql(digits));
        try {
            if (bpRows && bpRows.length > 0) {
                return {
                    cardCode: bpRows[0].CardCode,
                    cardName: bpRows[0].CardName,
                    Phone1: bpRows[0].Phone1,
                    Phone2: bpRows[0].Phone2,
                    U_jshshir: bpRows[0].U_jshshir,
                    Cellular: bpRows[0].Cellular,
                    created: false,
                };
            }
        } catch (err) {
            console.error("SAP search error:", err);
        }
    }
}

module.exports = new b1SL();

