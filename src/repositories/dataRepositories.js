const moment = require('moment');
const { db } = require('../config');

class DataRepositories {
    constructor(dbName) {
        this.db = dbName;
    }

    getSalesManager({ login = '', password = '' }) {
        return `
        SELECT T0."SlpCode", T0."SlpName", T0."GroupCode", T0."Telephone", T0."U_login", T0."U_password",T0."U_role" FROM ${this.db}.OSLP T0 where T0."U_login"= '${login}' and T0."U_password"='${password}'`;
    }

    getInvoice({ startDate, endDate, limit, offset, paymentStatus }) {

        let statusCondition = '';

        if (paymentStatus === 'paid') {
            statusCondition = `AND T0."PaidToDate" = T0."InsTotal"`;
        } else if (paymentStatus === 'unpaid') {
            statusCondition = `AND T0."PaidToDate" = 0`;
        } else if (paymentStatus === 'partial') {
            statusCondition = `AND T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal"`;
        }

        let count = `
        SELECT COUNT(*) AS total 
        FROM ${this.db}.INV6 T0
        INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
        INNER JOIN ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
        INNER JOIN ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
        AND T1."CANCELED" = 'N'
        ${statusCondition}  
        `;

        return `
        SELECT 
            (${count}) AS "Count",
            T2."CardCode", 
            T2."CardName", 
            T3."Dscription", 
            T2."Balance", 
            T2."Phone1", 
            T1."DocTotal", 
            T1."PaidToDate" as "TotalPaidToDate", 
            T0."PaidToDate",
            T1."Installmnt", 
            T0."DocEntry" AS "DocEntry",
            MAX(T0."DueDate") AS "Последняя дата оплаты",
            MAX(T0."InsTotal") AS "InsTotal"
        FROM 
            ${this.db}.INV6 T0
        INNER JOIN 
            ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
        INNER JOIN 
            ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
        INNER JOIN 
            ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
        WHERE 
            T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
            AND T1."CANCELED" = 'N'
            ${statusCondition}  
        GROUP BY 
            T2."CardCode", 
            T2."CardName", 
            T3."Dscription", 
            T2."Balance", 
            T2."Phone1", 
            T1."DocTotal", 
            T1."PaidToDate", 
            T1."Installmnt", 
            T0."DocEntry",
            T0."PaidToDate"
        LIMIT ${limit} OFFSET ${offset}
        `;
    }

}

module.exports = new DataRepositories(db);
