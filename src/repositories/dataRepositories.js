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



    getInvoice({ startDate, endDate, limit, offset, paymentStatus, cardCode, serial, phone, search, inInv = [], notInv = [], phoneConfiscated }) {

        let statusCondition = '';
        let businessPartnerCondition = '';
        let seriesCondition = ''
        let phoneCondition = ''
        let salesCondition = ''


        if (inInv.length && phoneConfiscated === 'true') {
            const inConditions = inInv.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `AND (${inConditions})`;
        }
        else if (notInv.length && phoneConfiscated === 'false') {
            const inConditions = inInv.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `AND NOT (${inConditions})`;
        }

        let searchCondition = '';
        if (search) {
            searchCondition = `
            AND (
                LOWER(TOSRI."IntrSerial") LIKE LOWER('%${search}%') OR
                LOWER(T2."CardName") LIKE LOWER('%${search}%')
            )
            `;
        }

        if (paymentStatus) {
            const statuses = paymentStatus.replace(/'/g, '').split(',').map(s => s.trim());
            const conditions = [];
            if (statuses.includes('paid')) {
                conditions.push(`(T0."PaidToDate" = T0."InsTotal")`);
            }
            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }
            if (statuses.includes('partial')) {
                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal")`);
            }

            if (conditions.length > 0) {
                statusCondition = `AND (${conditions.join(' OR ')})`;
            }
        }

        if (cardCode) {
            businessPartnerCondition = `AND T2."CardCode" =  '${cardCode}' `
        }

        if (serial) {
            let serialPatched = serial && serial.toUpperCase().replace(/'/g, "")
            seriesCondition = `AND UPPER("IntrSerial") LIKE '%${serialPatched}%'`
        }

        if (phone && phone !== '998') {
            // Agar telefon raqam 998 bilan boshlansa, uni kesib tashlaymiz
            const trimmedPhone = phone.startsWith('998') ? phone.slice(3) : phone;

            phoneCondition = `AND (T2."Phone1" LIKE '%${trimmedPhone}%' OR T2."Phone2" LIKE '%${trimmedPhone}%')`;
        }

        const INVOICE_TYPE = 13;
        return `
        WITH base_data AS (
            SELECT 
                T0."DocEntry", 
                T0."InstlmntID",
                T1."DocTotal", 
                T1."PaidToDate",
                MAX(T2."CardCode") as "CardCode",
                MAX(T2."CardName") as "CardName",
                MAX(T3."Dscription") as "Dscription",
                MAX(T2."Balance") as "Balance",
                MAX(T2."Phone1") as "Phone1",
                MAX(T2."Phone2") as "Phone2",
                MAX(T0."PaidToDate") AS "InstallmentPaidToDate",
                MAX(T1."Installmnt") as "Installmnt",
                MAX(T0."DueDate") as "DueDate",
                MAX(T0."InsTotal") as "InsTotal",
                STRING_AGG(TOSRI."IntrSerial", ', ') AS "IntrSerial",
                Max(T2."Cellular") as "Cellular"
            FROM ${this.db}.INV6 T0
            INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
            INNER JOIN ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
            INNER JOIN ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
            LEFT JOIN ${this.db}.SRI1 TSRI1 ON T3."DocEntry" = TSRI1."BaseEntry"
                AND TSRI1."BaseType" = 13
                AND TSRI1."BaseLinNum" = T3."LineNum"
            LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
                AND TOSRI."ItemCode" = TSRI1."ItemCode"
            WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
                AND T1."CANCELED" = 'N'
                ${statusCondition}
                ${businessPartnerCondition}
                ${seriesCondition}
                ${phoneCondition}
                ${searchCondition}
                ${salesCondition}
            GROUP BY T0."DocEntry", T0."InstlmntID" ,T1."DocTotal", 
            T1."PaidToDate"

        )
        
        SELECT 
            (SELECT COUNT(*) FROM base_data) AS "TOTAL",
            (SELECT SUM("InsTotal") FROM base_data) AS "DocTotal",
            (SELECT SUM("InstallmentPaidToDate") FROM base_data) AS "TotalPaidToDate",
            NULL AS "SlpCode",
            MAX("Cellular") as "Cellular",
            MAX("CardCode") AS "CardCode",
            MAX("CardName") AS "CardName",
            MAX("Dscription") AS "Dscription",
            MAX("Balance") AS "Balance",
            MAX("Phone1") AS "Phone1",
            MAX("Phone2") AS "Phone2",
            MAX("DocTotal") AS "MaxDocTotal",
            MAX("PaidToDate") AS "MaxTotalPaidToDate",
            MAX("InstallmentPaidToDate") AS "PaidToDate",
            MAX("Installmnt") AS "Installmnt",
            "InstlmntID",
            "DocEntry",
            MAX("DueDate") AS "DueDate",
            MAX("InsTotal") AS "InsTotal",
            STRING_AGG("IntrSerial", ', ') AS "IntrSerial"
        FROM base_data
        GROUP BY "DocEntry", "InstlmntID"  ,"DocTotal", 
        "PaidToDate"
        ORDER BY "DueDate" ASC, "DocEntry" ASC, "InstlmntID" ASC
        LIMIT ${limit} OFFSET ${offset};
                `;
    }

    getInvoiceById({ DocEntry, InstlmntID }) {
        return `   SELECT 
            T0."DocEntry", 
            T0."InstlmntID",
            T0."InsTotal"
    FROM ${this.db}.INV6 T0 WHERE T0."DocEntry" = ${DocEntry} and T0."InstlmntID" = ${InstlmntID}
 `
    }




    getDistributionInvoice({ startDate, endDate, limit, offset, paymentStatus, cardCode, serial, phone, invoices, search }) {
        let statusCondition = '';
        let businessPartnerCondition = '';
        let seriesCondition = '';
        let phoneCondition = '';
        let salesCondition = '';


        let searchCondition = '';
        if (search) {
            searchCondition = `
            AND (
                LOWER(TOSRI."IntrSerial") LIKE LOWER('%${search}%') OR
                LOWER(T2."CardName") LIKE LOWER('%${search}%')
            )
            `;
        }

        // 1. PAYMENT STATUS filter
        if (paymentStatus) {
            const statuses = paymentStatus.replace(/'/g, '').split(',').map(s => s.trim());
            const conditions = [];
            if (statuses.includes('paid')) {
                conditions.push(`(T0."PaidToDate" = T0."InsTotal")`);
            }
            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }
            if (statuses.includes('partial')) {
                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal")`);
            }
            if (conditions.length > 0) {
                statusCondition = `AND (${conditions.join(' OR ')})`;
            }
        }

        // 2. CARD CODE filter
        if (cardCode) {
            businessPartnerCondition = `AND T2."CardCode" = '${cardCode}'`;
        }

        // 3. SERIAL filter
        if (serial) {
            const serialPatched = serial.toUpperCase().replace(/'/g, "");
            seriesCondition = `AND UPPER(TOSRI."IntrSerial") LIKE '%${serialPatched}%'`;
        }

        // 4. PHONE filter
        if (phone && phone !== '998') {
            const trimmedPhone = phone.startsWith('998') ? phone.slice(3) : phone;
            phoneCondition = `AND (T2."Phone1" LIKE '%${trimmedPhone}%' OR T2."Phone2" LIKE '%${trimmedPhone}%')`;
        }

        // 5. SALES CONDITION (EXISTS bilan)
        if (invoices.length > 0) {
            salesCondition = `
        AND EXISTS (
            SELECT 1 FROM DUMMY
            WHERE (
                ${invoices.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}' AND T2."CardCode" = '${item.CardCode}')`
            ).join(' OR ')}
            )
        )`;
        }

        const INVOICE_TYPE = 13;


        return `
        WITH base_data AS (
            SELECT 
                T0."DocEntry", 
                T0."InstlmntID",
                T1."DocTotal", 
                T1."PaidToDate",
                MAX(T2."CardCode") as "CardCode",
                MAX(T2."CardName") as "CardName",
                MAX(T3."Dscription") as "Dscription",
                MAX(T2."Balance") as "Balance",
                MAX(T2."Phone1") as "Phone1",
                MAX(T2."Phone2") as "Phone2",
                MAX(T0."PaidToDate") AS "InstallmentPaidToDate",
                MAX(T1."Installmnt") as "Installmnt",
                MAX(T0."DueDate") as "DueDate",
                MAX(T0."InsTotal") as "InsTotal",
                STRING_AGG(TOSRI."IntrSerial", ', ') AS "IntrSerial",
                Max(T2."Cellular") as "Cellular"

            FROM ${this.db}.INV6 T0
            INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
            INNER JOIN ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
            INNER JOIN ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
            LEFT JOIN ${this.db}.SRI1 TSRI1 ON T3."DocEntry" = TSRI1."BaseEntry"
                AND TSRI1."BaseType" = 13
                AND TSRI1."BaseLinNum" = T3."LineNum"
            LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
                AND TOSRI."ItemCode" = TSRI1."ItemCode"
            WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
                AND T1."CANCELED" = 'N'
                ${statusCondition}
                ${businessPartnerCondition}
                ${seriesCondition}
                ${phoneCondition}
                ${salesCondition}
                ${searchCondition}
            GROUP BY T0."DocEntry", T0."InstlmntID" ,T1."DocTotal", 
            T1."PaidToDate"
        )
        
        SELECT 
            (SELECT COUNT(*) FROM base_data) AS "TOTAL",
            (SELECT SUM("InsTotal") FROM base_data) AS "DocTotal",
            (SELECT SUM("InstallmentPaidToDate") FROM base_data) AS "TotalPaidToDate",
            NULL AS "SlpCode",
            Max("Cellular") as "Cellular",
            MAX("CardCode") AS "CardCode",
            MAX("CardName") AS "CardName",
            MAX("Dscription") AS "Dscription",
            MAX("Balance") AS "Balance",
            MAX("Phone1") AS "Phone1",
            MAX("Phone2") AS "Phone2",
            MAX("DocTotal") AS "MaxDocTotal",
            MAX("PaidToDate") AS "MaxTotalPaidToDate",
            MAX("InstallmentPaidToDate") AS "PaidToDate",
            MAX("Installmnt") AS "Installmnt",
            "InstlmntID",
            "DocEntry",
            MAX("DueDate") AS "DueDate",
            MAX("InsTotal") AS "InsTotal",
            STRING_AGG("IntrSerial", ', ') AS "IntrSerial"
        FROM base_data
        GROUP BY "DocEntry", "InstlmntID" ,"DocTotal", 
        "PaidToDate"
        ORDER BY "DueDate" ASC, "DocEntry" ASC, "InstlmntID" ASC
        LIMIT ${limit} OFFSET ${offset};
                `;
    }



    getInvoiceSearchBPorSeria({ startDate, endDate, limit, offset, paymentStatus, search, phone, inInv = [], notInv = [], phoneConfiscated }) {
        let statusCondition = '';
        let salesCondition = ''

        if (inInv.length && phoneConfiscated === 'true') {
            const inConditions = inInv.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `AND (${inConditions})`;
        }
        else if (notInv.length && phoneConfiscated === 'false') {
            const inConditions = inInv.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `AND NOT (${inConditions})`;
        }


        if (paymentStatus) {
            const statuses = paymentStatus.replace(/'/g, '').split(',').map(s => s.trim());
            const conditions = [];
            if (statuses.includes('paid')) {
                conditions.push(`(T0."PaidToDate" = T0."InsTotal")`);
            }
            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }
            if (statuses.includes('partial')) {
                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal")`);
            }

            if (conditions.length > 0) {
                statusCondition = `AND (${conditions.join(' OR ')})`;
            }
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

        if (phone && phone !== '998') {
            const trimmedPhone = phone.startsWith('998') ? phone.slice(3) : phone;

            searchCondition += `
                AND (
                    T2."Phone1" LIKE '%${trimmedPhone}%' OR
                    T2."Phone2" LIKE '%${trimmedPhone}%'
                )
            `;
        }




        let count = `
            SELECT COUNT(*) 
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
            ${salesCondition}
        `;

        return `
            SELECT 
                (${count}) AS "TOTAL",
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
                ${salesCondition}
            GROUP BY 
                T2."CardCode", 
                T2."CardName", 
                T2."Phone1", 
                T2."Phone2"
            LIMIT ${limit} OFFSET ${offset}
        `;
    }


    getInvoiceSearchBPorSeriaDistribution({ startDate, endDate, limit, offset, paymentStatus, search, phone, invoices }) {
        let statusCondition = '';
        let salesCondition = `and (T1."DocEntry", T0."InstlmntID") IN (${invoices.map(item => `('${item.DocEntry}', '${item.InstlmntID}')`).join(", ")}) `

        if (paymentStatus) {
            const statuses = paymentStatus.replace(/'/g, '').split(',').map(s => s.trim());
            const conditions = [];
            if (statuses.includes('paid')) {
                conditions.push(`(T0."PaidToDate" = T0."InsTotal")`);
            }
            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }
            if (statuses.includes('partial')) {
                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal")`);
            }

            if (conditions.length > 0) {
                statusCondition = `AND (${conditions.join(' OR ')})`;
            }
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

        if (phone && phone !== '998') {
            const trimmedPhone = phone.startsWith('998') ? phone.slice(3) : phone;

            searchCondition += `
                AND (
                    T2."Phone1" LIKE '%${trimmedPhone}%' OR
                    T2."Phone2" LIKE '%${trimmedPhone}%'
                )
            `;
        }


        let count = `
            SELECT COUNT(*) 
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
            ${salesCondition}
        `;

        return `
            SELECT 
                (${count}) AS "Total",
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
                ${salesCondition}
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
      ${this.db}.INV6 T2
      LEFT JOIN 
      ${this.db}.RCT2 T0  ON T2."DocEntry" = T0."DocEntry"  and T2."InstlmntID" = T0."InstId" 
      LEFT JOIN 
          ${this.db}.ORCT T1 ON T0."DocNum" = T1."DocEntry" 
      LEFT JOIN 
          ${this.db}.OACT T3 ON T3."AcctCode" = COALESCE(T1."CashAcct", T1."CheckAcct") 
      WHERE 
       T2."DocEntry" = '${docEntry}' 
      ORDER BY 
          T2."InstlmntID" ASC`
        return sql
    }


    getAnalytics({ startDate, endDate, invoices = [], phoneConfiscated }) {
        let salesCondition = '';

        if (invoices.length > 0) {
            const condition = invoices.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}' AND T1."CardCode" = '${item.CardCode}')`
            ).join(' OR ');

            salesCondition = `
                ${phoneConfiscated === 'true' ? 'AND NOT EXISTS' : 'AND EXISTS'} (
                    SELECT 1 FROM DUMMY
                    WHERE ${condition}
                )
            `;
        }

        const sql = `
        SELECT
            SUM("SumApplied") AS "SumApplied",
            SUM("InsTotal") AS "InsTotal",
            SUM("PaidToDate") AS "PaidToDate"
        FROM (
            SELECT 
                MAX(T2."SumApplied") AS "SumApplied",
                MAX(T0."InsTotal") AS "InsTotal",
                MAX(T0."PaidToDate") AS "PaidToDate"
            FROM 
                ${this.db}.INV6 T0
                INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
                LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry" AND T0."InstlmntID" = T2."InstId"
                LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry"
                    AND T3."DocDate" BETWEEN '${startDate}' AND '${endDate}'
                    AND T3."Canceled" = 'N'
            WHERE
                T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
                AND T1."CANCELED" = 'N'
                ${salesCondition}
            GROUP BY T0."DocEntry", T0."InstlmntID"
        ) AS fixed
    `;

        return sql;
    }



    getAnalyticsByDay({ startDate, endDate, invoices = [], phoneConfiscated }) {
        let salesCondition = '';

        if (invoices.length > 0) {
            const condition = invoices.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}' AND T1."CardCode" = '${item.CardCode}')`
            ).join(' OR ');

            salesCondition = `
                ${phoneConfiscated === 'true' ? 'AND NOT EXISTS' : 'AND EXISTS'} (
                    SELECT 1 FROM DUMMY
                    WHERE ${condition}
                )
            `;
        }
        const sql = `
        SELECT
        "DueDate",
        SUM("SumApplied") AS "SumApplied",
        SUM("InsTotal") AS "InsTotal",
        SUM("PaidToDate") AS "PaidToDate"
    FROM (
        SELECT 
            TO_VARCHAR(T0."DueDate", 'YYYY.MM.DD') AS "DueDate",
            MAX(T2."SumApplied") AS "SumApplied",
            MAX(T0."InsTotal") AS "InsTotal",
            MAX(T0."PaidToDate") AS "PaidToDate"
        FROM 
            ${this.db}.INV6 T0
            INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
            LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry" AND T0."InstlmntID" = T2."InstId"
            LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry"
                AND T3."DocDate" BETWEEN '${startDate}' AND '${endDate}'
                AND T3."Canceled" = 'N'
        WHERE
            T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
            AND T1."CANCELED" = 'N'
            ${salesCondition}
        GROUP BY 
            T0."DocEntry", T0."InstlmntID", TO_VARCHAR(T0."DueDate", 'YYYY.MM.DD')
    ) AS fixed
    GROUP BY "DueDate"
    ORDER BY "DueDate"
    
    `;


        return sql;
    }








    getDistribution({ startDate, endDate, }) {
        let statusCondition = 'AND ((T0."PaidToDate" = 0) OR (T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal"))';
        // (T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal")
        // statusCondition = `AND (T0."PaidToDate" = 0)  `;
        // if (statuses.includes('unpaid')) {
        //     conditions.push(``);
        // }
        // if (statuses.includes('partial')) {
        //     conditions.push(``);
        // }
        const INVOICE_TYPE = 13;
        return `
            SELECT 
                null as "SlpCode",
            MAX(T2."CardCode") AS "CardCode", 
            MAX(T2."CardName") AS "CardName", 
            MAX(T3."Dscription") AS "Dscription", 
            MAX(T2."Balance") AS "Balance", 
            MAX(T2."Phone1") AS "Phone1", 
            MAX(T2."Phone2") AS "Phone2", 
            MAX(T1."DocTotal") AS "DocTotal", 
            MAX(T1."PaidToDate") AS "TotalPaidToDate", 
            MAX(T0."PaidToDate") AS "PaidToDate",
            MAX(T1."Installmnt") AS "Installmnt", 
            T0."InstlmntID",
            T0."DocEntry" AS "DocEntry",
            MAX(T0."DueDate") AS "DueDate",
            MAX(T0."InsTotal") AS "InsTotal",
            STRING_AGG(TOSRI."IntrSerial", ', ') AS "IntrSerial"
        FROM ${this.db}.INV6 T0
        INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
        INNER JOIN ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
        INNER JOIN ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
        LEFT JOIN ${this.db}.SRI1 TSRI1 ON T3."DocEntry" = TSRI1."BaseEntry"
            AND TSRI1."BaseType" = ${INVOICE_TYPE}
            AND TSRI1."BaseLinNum" = T3."LineNum"
        LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
            AND TOSRI."ItemCode" = TSRI1."ItemCode"
        WHERE 
            T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
            AND T1."CANCELED" = 'N'
            ${statusCondition}
        GROUP BY 
            T0."DocEntry",
            T0."InstlmntID"
            `;

    }
}

module.exports = new DataRepositories(db);


// SELECT T0."DueDate", T0."InsTotal", T0."PaidToDate" FROM INV6 T0  INNER JOIN OINV T1 ON T0."DocEntry" = T1."DocEntry"
//  LEFT JOIN
//       RCT2 T0  ON T2."DocEntry" = T0."DocEntry"  and T2."InstlmntID" = T0."InstId"
//       LEFT JOIN
//           ORCT T1 ON T0."DocNum" = T1."DocEntry"
//  WHERE T1."DocNum" = 21779 and T0."DueDate" BETWEEN '01.05.2025' AND '31.05.2025'