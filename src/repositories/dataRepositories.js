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

    getInvoice({ startDate, endDate, limit, offset, paymentStatus, cardCode, serial, phone }) {

        let statusCondition = '';
        let businessPartnerCondition = '';
        let seriesCondition = ''
        let phoneCondition = ''

        if (paymentStatus === 'paid') {
            statusCondition = `AND T0."PaidToDate" = T0."InsTotal"`;
        } else if (paymentStatus === 'unpaid') {
            statusCondition = `AND T0."PaidToDate" = 0`;
        } else if (paymentStatus === 'partial') {
            statusCondition = `AND T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal"`;
        }

        if (cardCode) {
            businessPartnerCondition = `AND T2."CardCode" =  '${cardCode}' `
        }

        if (serial) {
            let serialPatched = serial && serial.toUpperCase().replace(/'/g, "")
            seriesCondition = `AND UPPER("IntrSerial") LIKE '%${serialPatched}%'`
        }

        if (phone) {
            phoneCondition = `AND (T2."Phone1" LIKE '%${phone}%' OR T2."Phone2" LIKE '%${phone}%')`
        }

        const INVOICE_TYPE = 13;

        let count = `
        SELECT COUNT(*) AS total 
        FROM ${this.db}.INV6 T0
        INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
        INNER JOIN ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
        INNER JOIN ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
        LEFT JOIN ${this.db}.SRI1 TSRI1 ON T3."DocEntry" = TSRI1."BaseEntry"
            AND TSRI1."BaseType" = ${INVOICE_TYPE}
            AND TSRI1."BaseLinNum" = T3."LineNum"
        LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
            AND TOSRI."ItemCode" = TSRI1."ItemCode"
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
        AND T1."CANCELED" = 'N'
        ${statusCondition}  
        ${businessPartnerCondition}
        ${seriesCondition}
        ${phoneCondition}
        `;

        return `
        SELECT 
            (${count}) AS "Count",
            null as "SlpCode",
            T2."CardCode", 
            T2."CardName", 
            T3."Dscription", 
            T2."Balance", 
            T2."Phone1", 
            T2."Phone2", 
            T1."DocTotal", 
            T1."PaidToDate" as "TotalPaidToDate", 
            T0."PaidToDate",
            T1."Installmnt", T0."InstlmntID",
            T0."DocEntry" AS "DocEntry",
            MAX(T0."DueDate") AS "DueDate",
            MAX(T0."InsTotal") AS "InsTotal",
            STRING_AGG(TOSRI."IntrSerial",', ') AS "IntrSerial"
        FROM 
            ${this.db}.INV6 T0
        INNER JOIN 
            ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
        INNER JOIN 
            ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
        INNER JOIN 
            ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
        LEFT JOIN ${this.db}.SRI1 TSRI1 ON T3."DocEntry" = TSRI1."BaseEntry"
            AND TSRI1."BaseType" = ${INVOICE_TYPE}
            AND TSRI1."BaseLinNum" = T3."LineNum"
        LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
            AND TOSRI."ItemCode" = TSRI1."ItemCode"
        WHERE 
            T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
            AND T1."CANCELED" = 'N'
            ${statusCondition}  
            ${businessPartnerCondition}
            ${seriesCondition}
            ${phoneCondition}
        GROUP BY 
            T2."CardCode", 
            T2."CardName", 
            T3."Dscription", 
            T2."Balance", 
            T2."Phone1", 
            T2."Phone2", 
            T1."DocTotal", 
            T1."PaidToDate", 
            T1."Installmnt", 
            T0."DocEntry",
            T0."PaidToDate",
            T0."InstlmntID"
        LIMIT ${limit} OFFSET ${offset}
        `;
    }

    getInvoiceSearchBPorSeria({ startDate, endDate, limit, offset, paymentStatus, search, phone }) {
        let statusCondition = '';
        if (paymentStatus === 'paid') {
            statusCondition = `AND T0."PaidToDate" = T0."InsTotal"`;
        } else if (paymentStatus === 'unpaid') {
            statusCondition = `AND T0."PaidToDate" = 0`;
        } else if (paymentStatus === 'partial') {
            statusCondition = `AND T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal"`;
        }

        const INVOICE_TYPE = 13;

        let searchCondition = '';
        if (search) {
            searchCondition = `
            AND (
                LOWER(TOSRI."IntrSerial") LIKE LOWER('%${search}%') OR
                LOWER(T2."CardName") LIKE LOWER('%${search}%')
            )
            `;
        }

        if (phone) {
            searchCondition += `
                AND (
                    T2."Phone1" LIKE '%${phone}%' OR
                    T2."Phone2" LIKE '%${phone}%'
                )
            `;
        }

        let count = `
            SELECT COUNT(*) AS total
            FROM ${this.db}.INV6 T0
            INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
            INNER JOIN ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
            INNER JOIN ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
            LEFT JOIN ${this.db}.SRI1 TSRI1 ON T3."DocEntry" = TSRI1."BaseEntry"
                AND TSRI1."BaseType" = ${INVOICE_TYPE}
                AND TSRI1."BaseLinNum" = T3."LineNum"
            LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
                AND TOSRI."ItemCode" = TSRI1."ItemCode"
            WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
            AND T1."CANCELED" = 'N'
            ${statusCondition}
            ${searchCondition}
        `;

        return `
            SELECT 
                (${count}) AS "Count",
                T2."CardCode", 
                T2."CardName", 
                T2."Phone1", 
                T2."Phone2",
                STRING_AGG(TOSRI."IntrSerial", ', ') AS "IntrSerial"
            FROM 
                ${this.db}.INV6 T0
            INNER JOIN 
                ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
            INNER JOIN 
                ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
            INNER JOIN 
                ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
            LEFT JOIN ${this.db}.SRI1 TSRI1 ON T3."DocEntry" = TSRI1."BaseEntry"
                AND TSRI1."BaseType" = ${INVOICE_TYPE}
                AND TSRI1."BaseLinNum" = T3."LineNum"
            LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
                AND TOSRI."ItemCode" = TSRI1."ItemCode"
            WHERE 
                T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
                AND T1."CANCELED" = 'N'
                ${statusCondition}
                ${searchCondition}
            GROUP BY 
                T2."CardCode", 
                T2."CardName", 
                T2."Phone1", 
                T2."Phone2"
            LIMIT ${limit} OFFSET ${offset}
        `;
    }


    getSalesPersons() {
        let sql = `
        SELECT T0."SlpCode", T0."SlpName", T0."U_login", T0."U_role" FROM ${this.db}.OSLP T0  WHERE T0."U_role" IS NOT NULL
        `
        return sql
    }

    getRate({ currency = 'UZS', date = '' }) {
        let sql = `
            SELECT T0."RateDate", T0."Currency", T0."Rate"
            FROM ${this.db}.ORTT T0
            WHERE T0."Currency" = '${currency}'
            AND T0."RateDate" = ${date ? `'${date}'` : 'CURRENT_DATE'}
        `;
        return sql;
    }

    getPayList({ docEntry }) {
        let sql = `SELECT 
      T1."Canceled", 
      T0."DocNum", 
      T0."DocEntry", 
      T0."SumApplied", 
      T0."InstId", 
      T1."CashAcct", 
      T1."DocDate", 
      T1."CheckAcct", 
      T2."InstlmntID", 
      T2."DueDate", 
      T2."PaidToDate", 
      T2."InsTotal" ,
      T3."AcctName"
  FROM 
      ${this.db}.RCT2 T0  
  INNER JOIN 
      ${this.db}.ORCT T1 ON T0."DocNum" = T1."DocEntry" 
  FULL JOIN 
      ${this.db}.INV6 T2 ON T2."DocEntry" = T0."DocEntry" AND T2."InstlmntID" = T0."InstId" 
  FULL JOIN 
      ${this.db}.OACT T3 ON T3."AcctCode" = COALESCE(T1."CashAcct", T1."CheckAcct") 
  WHERE 
   T2."DocEntry" = '${docEntry}' and T1."Canceled"= 'N'
  ORDER BY 
      T2."InstlmntID" ASC`
        return sql
    }
}

module.exports = new DataRepositories(db);
