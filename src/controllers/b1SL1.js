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
        T0."Phone2"
    FROM ${db}.OCRD T0
    WHERE
         (
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

    updateBusinessPartner = async ({ Phone1, Phone2, CardCode , CardName ,U_jshshir=null,Cellular=null}) => {

        let body = {
            "Currency": "UZS",
            U_jshshir,
            Cellular
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

    createBusinessPartner = async ({ Phone1, Phone2, CardName , U_jshshir , Cellular }) => {
        const rand = String.fromCharCode(65 + Math.floor(Math.random() * 26));
        const CardCode = `BP${moment().format('YYMMDDHHmmss')}${rand}`;

        let body = { CardCode, CardName , "Currency": "UZS", U_jshshir ,Cellular};
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

    normalizePayments(payments) {
        if (!Array.isArray(payments)) return [];
        return payments
            .filter((p) => p && typeof p === 'object')
            .map((p) => ({
                type: String(p.type || '').trim(),     // Cash | Card | Terminal
                amount: Number(p.amount || 0),         // UZS
            }))
            .filter((p) =>
                (p.type === 'Cash' || p.type === 'Card' || p.type === 'Terminal') &&
                p.amount > 0
            );
    }

    getCashAccountByBranch(branchCode) {
        const map = { '1': '5040', '2': '5010', '3': '5060' };
        const acc = map[String(branchCode)];
        if (!acc) throw new Error(`CashAccount not found for branch=${branchCode}`);
        return acc;
    }

    resolveCashAccount(type, branchCode) {
        if (type === 'Terminal') return '5710';
        if (type === 'Card') return '5020';
        return this.getCashAccountByBranch(branchCode); // Cash
    }

    buildIncomingPaymentBody({ cardCode, branchCode, docRate, payment }) {
        const rate = Number(docRate || 11990);
        if (!(rate > 0)) throw new Error('DocRate must be > 0');

        const amountUZS = Number(payment.amount || 0);
        if (!(amountUZS > 0)) throw new Error(`Invalid payment amount for ${payment.type}`);

        const cashAccount = this.resolveCashAccount(payment.type, branchCode);

        return {
            CardCode: cardCode,
            DocCurrency: 'UZS',
            CashSum: amountUZS,
            CashAccount: cashAccount,
            PaymentInvoices: [
                {
                    DocEntry: '__INVOICE_DOCENTRY__',
                    "AppliedFC": amountUZS,
                    "AppliedSys":amountUZS,
                    InstallmentId: 1,
                },
            ],
        };
    }

    buildPaymentBodies({ cardCode, branchCode, docRate, payments }) {
        const normalized = this.normalizePayments(payments);
        return normalized.map((p) =>
            this.buildIncomingPaymentBody({ cardCode, branchCode, docRate, payment: p })
        );
    }

    buildBatchInvoiceAndPayments(invoiceBody, paymentBodies = []) {
        const batchId = `batch_${crypto.randomUUID()}`;
        const changeSetId = `changeset_${crypto.randomUUID()}`;
        const CRLF = '\r\n';

        const parts = [];

        // ✅ Invoice (Content-ID:1)
        parts.push(
            `--${changeSetId}${CRLF}` +
            `Content-Type: application/http${CRLF}` +
            `Content-Transfer-Encoding: binary${CRLF}` +
            `Content-ID: 1${CRLF}${CRLF}` +
            `POST /b1s/v1/Invoices HTTP/1.1${CRLF}` +
            `Content-Type: application/json${CRLF}${CRLF}` +
            `${JSON.stringify(invoiceBody)}${CRLF}${CRLF}` // ✅ MUHIM: JSON dan keyin 2 ta CRLF
        );

        // ✅ Payments (Content-ID:2..)
        for (let i = 0; i < paymentBodies.length; i++) {
            const pBody = paymentBodies[i];

            const json = JSON.stringify(pBody).replace(
                '"__INVOICE_DOCENTRY__"',
                '$1'
            );

            parts.push(
                `--${changeSetId}${CRLF}` +
                `Content-Type: application/http${CRLF}` +
                `Content-Transfer-Encoding: binary${CRLF}` +
                `Content-ID: ${i + 2}${CRLF}${CRLF}` +
                `POST /b1s/v1/IncomingPayments HTTP/1.1${CRLF}` +
                `Content-Type: application/json${CRLF}${CRLF}` +
                `${json}${CRLF}${CRLF}` // ✅ MUHIM: JSON dan keyin 2 ta CRLF
            );
        }

        const payload =
            `--${batchId}${CRLF}` +
            `Content-Type: multipart/mixed; boundary=${changeSetId}${CRLF}${CRLF}` +
            parts.join('') +
            `--${changeSetId}--${CRLF}` +
            `--${batchId}--${CRLF}`;

        return { batchId, payload };
    }

    parseSapBatchResponseMulti(raw) {
        const blocks = String(raw || '').split('HTTP/1.1').slice(1);

        let invoice = null;
        const payments = [];
        const errors = [];

        for (const block of blocks) {
            const status = Number(block.substring(0, 3));
            const jsonMatch = block.match(/\{[\s\S]*\}/);
            let json = null;

            if (jsonMatch) {
                try { json = JSON.parse(jsonMatch[0]); } catch { json = null; }
            }

            if (status >= 400) {
                errors.push(json?.error?.message?.value || 'Unknown SAP error');
                continue;
            }

            if (json?.DocEntry && !invoice) {
                invoice = { DocEntry: json.DocEntry, DocNum: json.DocNum };
                continue;
            }

            if (json?.DocEntry && invoice) {
                payments.push({ DocEntry: json.DocEntry, DocNum: json.DocNum });
            }
        }

        return { ok: errors.length === 0, invoice, payments, errors };
    }

    createInvoiceAndPayment = async (req, res, next) => {
        try {
            // 0) seller check
            if (!req.user?.U_branch) {
                return res.status(400).json({
                    status: false,
                    message: "Siz Sotuvchi emassiz",
                });
            }

            // 1) leadId
            const leadId = req.body.leadId;
            delete req.body.leadId;
            delete req.body.selectedDevices;

            if (!leadId) {
                return res.status(400).json({
                    status: false,
                    message: "leadId is required",
                });
            }

            // 2) SAP’da shu leadId bilan invoice bor-yo‘qligini tekshirish
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
                    DocNum: existingInvoices[0].DocNum,
                });
            }

            let body = { ...req.body };

            const rawPhone = body.clientPhone;
            const normalizedPhone = this.normalizePhone(rawPhone);

            if (!normalizedPhone) {
                return res.status(400).json({
                    status: false,
                    message: "Invalid client phone number",
                });
            }

            const bpRows = await execute(this.findBpByPhoneSql(normalizedPhone));

            let cardCode;
            let createdBP = false;

            if (bpRows?.length) {
                cardCode = bpRows[0].CardCode;
            } else {
                const bp = await this.createBusinessPartner({
                    CardName: body.clientName || "No Name",
                    Phone1: normalizedPhone,
                    Currency: "UZS",
                    U_jshshir: body.jshshir,
                    Cellular: body.passportId,
                });

                if (!bp?.CardCode) {
                    return res.status(400).json({
                        status: false,
                        message: bp?.message || "Failed to create Business Partner",
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


            const paymentsInput = body.payments;
            const docRate = Number(body.DocRate || 11990);


            // ✅ payments input (0..3)
            delete body.payments;

            delete body.DocRate;
            delete body.CashSum;
            delete body.paymentType;

            const paymentBodies = this.buildPaymentBodies({
                cardCode: body.CardCode,
                branchCode: req.user.U_branch,
                docRate,
                payments: paymentsInput,
            });

            delete body.payments;
            delete body.DocRate;
            delete body.CashSum;
            delete body.paymentType;

            const { batchId, payload } = this.buildBatchInvoiceAndPayments(body, paymentBodies);
            console.log(payload)

            const axiosInstance = Axios.create({
                baseURL: `${this.api}`,
                timeout: 30000,
                headers: {
                    "Content-Type": `multipart/mixed;boundary=${batchId}`,
                    Cookie: get(getSession(), "Cookie[0]", "") + get(getSession(), "Cookie[1]", ""),
                    SessionId: get(getSession(), "SessionId", ""),
                },
                httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            });

            const response = await axiosInstance.post(`/$batch`, payload);

            const parsed = this.parseSapBatchResponseMulti(response.data);

            if (!parsed.ok) {
                return res.status(400).json({
                    status: false,
                    message: "SAP batch error",
                    errors: parsed.errors,
                    raw: response.data,
                });
            }

            if (!parsed.invoice?.DocEntry) {
                return res.status(400).json({
                    status: false,
                    message: `Invoice was not created in SAP`,
                    raw: response.data,
                });
            }

            if (paymentBodies.length > 0 && parsed.payments.length !== paymentBodies.length) {
                return res.status(400).json({
                    status: false,
                    message: "Some Incoming Payments were not created in SAP",
                    expected: paymentBodies.length,
                    created: parsed.payments.length,
                    errors: parsed.errors,
                    raw: response.data,
                });
            }

            const invoiceDocEntry = parsed.invoice.DocEntry;
            const invoiceDocNum = parsed.invoice.DocNum;

            await LeadModel.updateOne(
                { _id: leadId },
                {
                    $set: {
                        invoiceCreated: true,
                        invoiceDocEntry,
                        invoiceDocNum,
                        invoiceCreatedAt: new Date(),

                        paymentCreated: paymentBodies.length > 0,
                        paymentCreatedAt: paymentBodies.length > 0 ? new Date() : null,

                        ...(createdBP && { cardCode: body.CardCode }),
                    },
                }
            );

            return res.status(201).json({
                status: true,
                invoiceDocEntry,
                invoiceDocNum,
                paymentsCreated: parsed.payments.length,
                raw: response.data,
            });
        } catch (err) {
            console.log("Batch SAP Error:", err?.response?.data || err);

            if (get(err, "response.status") == 401) {
                const token = await this.auth();
                if (token.status) return this.createInvoiceAndPayment(req, res, next);
                return res.status(401).json({ status: false, message: token.message });
            }

            const sapErr = get(err, "response.data.error.message.value", "SAP error");
            return res.status(400).json({
                status: false,
                message: sapErr,
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


