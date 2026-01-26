const moment = require('moment');
const { db } = require('../config');

class DataRepositories {
    constructor(dbName) {
        this.db = dbName;
    }

    async getSalesManager({ login = '', password = '' }) {
        return `
        SELECT T0."SlpCode", T0."SlpName", T0."GroupCode", T0."Telephone", T0."U_login", T0."U_password",T0."U_role" , T0."U_branch" FROM ${this.db}.OSLP T0 where T0."U_login"= '${login}' and T0."U_password"='${password}'`;
    }

    async getInvoice({ startDate, endDate, limit, offset, paymentStatus, cardCode, serial, phone, search, inInv = [], notInv = [], phoneConfiscated, partial }) {

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
            const inConditions = notInv.map(item =>
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
                let partialCondition = '';
                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `(T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}')`
                    ).join(' OR ');

                    partialCondition = `OR (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" = T0."InsTotal" ${partial?.length > 0 ? partialCondition : ''})`);
            }

            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }

            if (statuses.includes('partial')) {
                let excludePartials = '';

                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `NOT (T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}')`
                    ).join(' AND '); // <-- AND ishlatamiz, chunki har bir kombinatsiyani inkor qilish kerak

                    excludePartials = `AND (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal" ${excludePartials})`);
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

        return `
        WITH base_data AS (
            SELECT 
                T0."DocEntry", 
                T0."InstlmntID",
                T1."DocTotal",
                T1."DocTotalFC",
                T1."PaidToDate",
                T1."PaidFC",
                T1."DocCur",
                MAX(T2."CardCode") as "CardCode",
                MAX(T2."CardName") as "CardName",
                MAX(T3."Dscription") as "Dscription",
                MAX(T2."Balance") as "Balance",
                MAX(T2."Phone1") as "Phone1",
                MAX(T2."Phone2") as "Phone2",
                MAX(T0."PaidToDate") AS "InstallmentPaidToDate",
                MAX(T0."PaidFC") AS "InstallmentPaidToDateFC",
                MAX(T1."Installmnt") as "Installmnt",
                MAX(T0."DueDate") as "DueDate",
                MAX(T0."InsTotal") as "InsTotal",
                Max(T0."InsTotalFC") as "InsTotalFC",
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
                  AND NOT EXISTS (
                    SELECT 1
                    FROM ${this.db}.RIN1 CM1
                             INNER JOIN ${this.db}.ORIN CM0
                                        ON CM0."DocEntry" = CM1."DocEntry"
                    WHERE CM1."BaseType" = 13              
                      AND CM1."BaseEntry" = T1."DocEntry"
                )
                ${statusCondition}
                ${businessPartnerCondition}
                ${seriesCondition}
                ${phoneCondition}
                ${searchCondition}
                ${salesCondition}
            GROUP BY T0."DocEntry", T0."InstlmntID" ,T1."DocTotal", 
            T1."PaidToDate", T1."DocTotalFC", T1."PaidFC" , T1."DocCur"

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
            "DocCur" AS "DocCur",
            MAX("DocTotalFC") AS "MaxDocTotalFC",
            MAX("PaidFC") AS "MaxTotalPaidToDateFC",
            
            MAX("InstallmentPaidToDateFC") AS "PaidToDateFC",
            Max("InsTotalFC") as "InsTotalFC",
            
            MAX("InstallmentPaidToDate") AS "PaidToDate",
            MAX("Installmnt") AS "Installmnt",
            
            "InstlmntID",
            "DocEntry",
            MAX("DueDate") AS "DueDate",
            MAX("InsTotal") AS "InsTotal",
            STRING_AGG("IntrSerial", ', ') AS "IntrSerial"
        FROM base_data
        GROUP BY "DocEntry", "InstlmntID"  ,"DocTotal", 
        "PaidToDate" , "DocTotalFC" , "PaidFC" ,"DocCur"
        ORDER BY "DueDate" ASC, "DocEntry" ASC, "InstlmntID" ASC
        LIMIT ${limit} OFFSET ${offset};
                `;
    }

    async getDistributionInvoice({ startDate, endDate, limit, offset, paymentStatus, cardCode, serial, phone, invoices, search, partial }) {
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


        if (paymentStatus) {
            const statuses = paymentStatus.replace(/'/g, '').split(',').map(s => s.trim());
            const conditions = [];

            if (statuses.includes('paid')) {
                let partialCondition = '';
                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `(T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}' )`
                    ).join(' OR ');

                    partialCondition = `OR (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" = T0."InsTotal" ${partial?.length > 0 ? partialCondition : ''})`);
            }

            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }

            if (statuses.includes('partial')) {
                let excludePartials = '';

                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `NOT (T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}' )`
                    ).join(' AND '); // <-- AND ishlatamiz, chunki har bir kombinatsiyani inkor qilish kerak

                    excludePartials = `AND (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal" ${excludePartials})`);
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
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ')}
            )
        )`;
        }

        return `
        WITH base_data AS (
            SELECT 
                T0."DocEntry", 
                T0."InstlmntID",

                T1."DocTotal",
                T1."DocTotalFC",
                T1."PaidToDate",
                T1."PaidFC",
                T1."DocCur",
                MAX(T2."CardCode") as "CardCode",
                MAX(T2."CardName") as "CardName",
                MAX(T3."Dscription") as "Dscription",
                MAX(T2."Balance") as "Balance",
                MAX(T2."Phone1") as "Phone1",
                MAX(T2."Phone2") as "Phone2",
                MAX(T0."PaidToDate") AS "InstallmentPaidToDate",
                MAX(T0."PaidFC") AS "InstallmentPaidToDateFC",
                Max(T0."InsTotalFC") as "InsTotalFC",
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
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.db}.RIN1 CM1
                         INNER JOIN ${this.db}.ORIN CM0
                                    ON CM0."DocEntry" = CM1."DocEntry"
                WHERE CM1."BaseType" = 13              -- A/R Invoice
                  AND CM1."BaseEntry" = T1."DocEntry"
            )
                ${statusCondition}
                ${businessPartnerCondition}
                ${seriesCondition}
                ${phoneCondition}
                ${salesCondition}
                ${searchCondition}
            GROUP BY T0."DocEntry", T0."InstlmntID" ,T1."DocTotal", 
            T1."PaidToDate" , T1."DocTotalFC", T1."PaidFC" , T1."DocCur"
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
            "DocCur" AS "DocCur",
            MAX("DocTotalFC") AS "MaxDocTotalFC",
            MAX("PaidFC") AS "MaxTotalPaidToDateFC",

            MAX("InstallmentPaidToDateFC") AS "PaidToDateFC",
            Max("InsTotalFC") as "InsTotalFC",
            
            MAX("InstallmentPaidToDate") AS "PaidToDate",
            MAX("Installmnt") AS "Installmnt",
            "InstlmntID",
            "DocEntry",
            MAX("DueDate") AS "DueDate",
            MAX("InsTotal") AS "InsTotal",
            STRING_AGG("IntrSerial", ', ') AS "IntrSerial"
        FROM base_data
        GROUP BY "DocEntry", "InstlmntID" ,"DocTotal", 
        "PaidToDate" , "DocTotalFC" , "PaidFC" ,"DocCur"
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

    getInvoiceSearchBPorSeria({ startDate, endDate, limit, offset, paymentStatus, search, phone, inInv = [], notInv = [], phoneConfiscated, partial }) {
        let statusCondition = '';
        let salesCondition = ''

        if (inInv.length && phoneConfiscated === 'true') {
            const inConditions = inInv.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `AND (${inConditions})`;
        }
        else if (notInv.length && phoneConfiscated === 'false') {
            const inConditions = notInv.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `AND NOT (${inConditions})`;
        }

        if (paymentStatus) {
            const statuses = paymentStatus.replace(/'/g, '').split(',').map(s => s.trim());
            const conditions = [];

            if (statuses.includes('paid')) {
                // To‘liq to‘langanlar va partial listdagi to‘lanmaganlar (lekin qisman bo‘lganlar)
                let partialCondition = '';
                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `(T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}')`
                    ).join(' OR ');

                    partialCondition = `OR (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" = T0."InsTotal" ${partial?.length > 0 ? partialCondition : ''})`);
            }

            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }

            if (statuses.includes('partial')) {
                let excludePartials = '';

                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `NOT (T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}')`
                    ).join(' AND '); // <-- AND ishlatamiz, chunki har bir kombinatsiyani inkor qilish kerak

                    excludePartials = `AND (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal" ${excludePartials})`);
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
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.db}.RIN1 CM1
                         INNER JOIN ${this.db}.ORIN CM0
                                    ON CM0."DocEntry" = CM1."DocEntry"
                WHERE CM1."BaseType" = 13              -- A/R Invoice
                  AND CM1."BaseEntry" = T1."DocEntry"
            )
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

    async getInvoiceSearchBPorSeriaDistribution({ startDate, endDate, limit, offset, paymentStatus, search, phone, invoices, partial }) {
        let statusCondition = '';
        let salesCondition = `and (T1."DocEntry", T0."InstlmntID") IN (${invoices.map(item => `('${item.DocEntry}', '${item.InstlmntID}')`).join(", ")}) `

        if (paymentStatus) {
            const statuses = paymentStatus.replace(/'/g, '').split(',').map(s => s.trim());
            const conditions = [];

            if (statuses.includes('paid')) {
                // To‘liq to‘langanlar va partial listdagi to‘lanmaganlar (lekin qisman bo‘lganlar)
                let partialCondition = '';
                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `(T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}'`
                    ).join(' OR ');

                    partialCondition = `OR (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" = T0."InsTotal" ${partial?.length > 0 ? partialCondition : ''})`);
            }

            if (statuses.includes('unpaid')) {
                conditions.push(`(T0."PaidToDate" = 0)`);
            }

            if (statuses.includes('partial')) {
                let excludePartials = '';

                if (partial?.length > 0) {
                    const partialFilter = partial.map(p =>
                        `NOT (T0."DocEntry" = '${p.DocEntry}' AND T0."InstlmntID" = '${p.InstlmntID}')`
                    ).join(' AND ');

                    excludePartials = `AND (${partialFilter})`;
                }

                conditions.push(`(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal" ${excludePartials})`);
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
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.db}.RIN1 CM1
                         INNER JOIN ${this.db}.ORIN CM0
                                    ON CM0."DocEntry" = CM1."DocEntry"
                WHERE CM1."BaseType" = 13              -- A/R Invoice
                  AND CM1."BaseEntry" = T1."DocEntry"
            )
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
    INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
    INNER JOIN ${this.db}.OCRD T2 ON T1."CardCode" = T2."CardCode"
    INNER JOIN ${this.db}.INV1 T3 ON T1."DocEntry" = T3."DocEntry"
    LEFT JOIN ${this.db}.SRI1 TSRI1 
        ON T3."DocEntry" = TSRI1."BaseEntry"
        AND TSRI1."BaseType" = ${INVOICE_TYPE}
        AND TSRI1."BaseLinNum" = T3."LineNum"
    LEFT JOIN ${this.db}."OSRI" TOSRI 
        ON TSRI1."SysSerial" = TOSRI."SysSerial"
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
LIMIT ${limit} OFFSET ${offset};
        `;
    }

    getSalesPersons({ exclude = [], include = []  , branch} = {}) {
        let whereClause = `WHERE T0."U_role" IS NOT NULL`;

        if (include.length > 0) {
            whereClause += ` AND T0."U_role" IN (${include.map(r => `'${r}'`).join(', ')})`;
        } else if (exclude.length > 0) {
            whereClause += ` AND T0."U_role" NOT IN (${exclude.map(r => `'${r}'`).join(', ')})`;
        }

        if(branch) {
            whereClause += ` AND T0."U_branch" = '${branch}'`;
        }

        return `
            SELECT
                T0."SlpCode",
                T0."SlpName",
                T0."U_login",
                T0."U_role",
                T0."U_summa",
                T0."U_workDay",
                T0."U_branch"
            FROM ${this.db}.OSLP T0
                ${whereClause}
        `;
    }

    getRate({ currency = 'UZS', date = '' }) {
        return  `
            SELECT T0."RateDate", T0."Currency", T0."Rate"
            FROM ${this.db}.ORTT T0
            WHERE T0."Currency" = '${currency}'
            AND T0."RateDate" = ${date ? `'${date}'` : 'CURRENT_DATE'}
        `;
    }

    getPayList({ docEntry }) {
        return `SELECT
    T1."Canceled",
    T0."DocNum",
    T0."DocEntry",
    T0."SumApplied",
    T0."AppliedSys" as "AppliedFC",
    T0."InstId",
    T1."CashAcct",
    T1."DocDate",
    T1."CheckAcct",
    T1."DocCurr" as "Currency",
    T2."InstlmntID",
    T2."DueDate",
    T2."PaidToDate",
    T2."InsTotal",
    T2."PaidFC",
    T2."InsTotalFC",
    T4."DocCur",
    T3."AcctName",
    T4."CardCode",
    T4."CardName",
    T4."DocTotal" as "MaxDocTotal",
    T4."DocTotalFC" as "MaxDocTotalFC",
    T4."PaidFC" as "MaxTotalPaidToDateFC",
    T4."PaidToDate" as "MaxTotalPaidToDate",
    T5."Cellular",
    T5."Phone1",
    T5."Phone2",
    T6."ItemCode",
    T6."Dscription",
    STRING_AGG(TOSRI."IntrSerial", ', ') AS "IntrSerial"
FROM
    ${this.db}.INV6 T2
    LEFT JOIN ${this.db}.RCT2 T0 ON T2."DocEntry" = T0."DocEntry" AND T2."InstlmntID" = T0."InstId"
    LEFT JOIN ${this.db}.ORCT T1 ON T0."DocNum" = T1."DocEntry"
    LEFT JOIN ${this.db}.OACT T3 ON T3."AcctCode" = COALESCE(T1."CashAcct", T1."CheckAcct")
    LEFT JOIN ${this.db}.OINV T4 ON T4."DocEntry" = T2."DocEntry"
    INNER JOIN ${this.db}.OCRD T5 ON T4."CardCode" = T5."CardCode"
    LEFT JOIN ${this.db}.INV1 T6 ON T6."DocEntry" = T4."DocEntry" AND T6."LineNum" = 0
    LEFT JOIN ${this.db}.SRI1 TSRI1 ON T6."DocEntry" = TSRI1."BaseEntry"
        AND TSRI1."BaseType" = 13 AND TSRI1."BaseLinNum" = T6."LineNum"
    LEFT JOIN ${this.db}."OSRI" TOSRI ON TSRI1."SysSerial" = TOSRI."SysSerial"
        AND TOSRI."ItemCode" = TSRI1."ItemCode"
WHERE
    T2."DocEntry" = '${docEntry}'
GROUP BY
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
    T2."InsTotal",
    T2."PaidFC",
    T2."InsTotalFC",
    T3."AcctName",
    T4."CardCode",
    T4."CardName",
    T4."DocTotal",
    T4."PaidToDate",
    T4."DocTotalFC",
    T4."PaidFC",
    T5."Cellular",
    T5."Phone1",
    T5."Phone2",
    T6."ItemCode",
    T6."Dscription",
    T4."DocCur",
    T0."AppliedSys",
    T4."PaidToDate",
    T1."DocCurr"
ORDER BY
    T2."InstlmntID" ASC
`
    }

    getAnalytics({ startDate, endDate, invoices = [], phoneConfiscated }) {
        let salesCondition = '';

        if (invoices.length > 0) {
            const condition = invoices.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `
                ${phoneConfiscated === 'true' ? 'AND NOT EXISTS' : 'AND EXISTS'} (
                    SELECT 1 FROM DUMMY
                    WHERE ${condition}
                )
            `;
        }

        const newEndDate = moment(endDate, 'YYYY.MM.DD')
            .endOf('month')
            .add(10, 'days')
            .format('YYYY.MM.DD');

        console.log(startDate , endDate , newEndDate , " get Analytics")

        let sql = `SELECT 
            SUM(T2."SumApplied") as "SumApplied",
            (
                SELECT SUM(T0."InsTotal")
                FROM ${this.db}.INV6 T0
                JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry"
                WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}'
                  AND T1."CANCELED" = 'N' and T1."CardCode" not in ('Naqd','Bonus')
                  AND NOT EXISTS (
                    SELECT 1
                    FROM ${this.db}.RIN1 CM1
                             INNER JOIN ${this.db}.ORIN CM0
                                        ON CM0."DocEntry" = CM1."DocEntry"
                    WHERE CM1."BaseType" = 13              -- A/R Invoice
                      AND CM1."BaseEntry" = T1."DocEntry"
                )
           ) AS "InsTotal",
            SUM(T0."PaidToDate") as "PaidToDate",
            SUM(T0."InsTotal") as "InsTotal2"
        FROM 
        ${this.db}.INV6 T0  INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry" 
        LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry"  and T0."InstlmntID" = T2."InstId" 
        LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry"  and T3."Canceled" = 'N' 
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}' and T1."CANCELED" = 'N' and T1."CardCode" not in ('Naqd','Bonus')
        AND NOT EXISTS (
            SELECT 1
            FROM ${this.db}.RIN1 CM1
                     INNER JOIN ${this.db}.ORIN CM0
                                ON CM0."DocEntry" = CM1."DocEntry"
            WHERE CM1."BaseType" = 13              -- A/R Invoice
              AND CM1."BaseEntry" = T1."DocEntry"  -- shu invoice
        )
        ${salesCondition}
        `
        return sql
    }

    getAnalyticsByDay({ startDate, endDate, invoices = [], phoneConfiscated }) {
        let salesCondition = '';
        if (invoices.length > 0) {
            const condition = invoices.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}') `
            ).join(' OR ');

            salesCondition = `
                ${phoneConfiscated === 'true' ? 'AND NOT EXISTS' : 'AND EXISTS'} (
                    SELECT 1 FROM DUMMY
                    WHERE ${condition}
                )
            `;
        }

        const newEndDate = moment(endDate, 'YYYY.MM.DD')
            .endOf('month')
            .add(10, 'days')
            .format('YYYY.MM.DD');


        let sql = `SELECT 
            TO_VARCHAR(T0."DueDate", 'YYYY.MM.DD') AS "DueDate",
            COALESCE(SUM(T2."SumApplied"), 0) AS "SumApplied",
            SUM(T0."InsTotal") as "InsTotal", 
            SUM(T0."PaidToDate") as "PaidToDate"
        FROM 
        ${this.db}.INV6 T0  INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry" 
        LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry"  and T0."InstlmntID" = T2."InstId" 
        LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry" and T3."DocDate" BETWEEN '${startDate}' and '${newEndDate}' and T3."Canceled" = 'N' 
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}' and T1."CANCELED" = 'N'
        ${salesCondition}
        GROUP BY T0."DueDate"
        ORDER BY T0."DueDate"
        `
        return sql
    }

    getAnalyticsBySlpCode({ startDate, endDate, invoices = [], phoneConfiscated }) {
        let salesCondition = '';

        if (invoices.length > 0) {
            const condition = invoices.map(item =>
                `(T1."DocEntry" = '${item.DocEntry}' AND T0."InstlmntID" = '${item.InstlmntID}')`
            ).join(' OR ');

            salesCondition = `
                ${phoneConfiscated === 'true' ? 'AND NOT EXISTS' : 'AND EXISTS'} (
                    SELECT 1 FROM DUMMY
                    WHERE ${condition}
                )
            `;
        }
        const newEndDate = moment(endDate, 'YYYY.MM.DD')
            .endOf('month')
            .add(10, 'days')
            .format('YYYY.MM.DD');

        let sql = `
        SELECT 
            T0."DocEntry",
            T0."InstlmntID",
            T2."SumApplied",  
            T0."InsTotal", 
           T0."PaidToDate"
        FROM 
        ${this.db}.INV6 T0  INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry" 
        LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry"  and T0."InstlmntID" = T2."InstId" 
        LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry" and T3."Canceled" = 'N' 
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}' and T1."CANCELED" = 'N' and T1."CardCode" not in ('Naqd','Bonus')
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.db}.RIN1 CM1
                     INNER JOIN ${this.db}.ORIN CM0
                                ON CM0."DocEntry" = CM1."DocEntry"
            WHERE CM1."BaseType" = 13              -- A/R Invoice
              AND CM1."BaseEntry" = T1."DocEntry"
        )
        ${salesCondition}
        `
        return sql
    }

    getBusinessPartners({ jshshir, passport, phone }) {
        return `
            SELECT
                T0."U_blocked",
                T0."CardCode",
                T0."CardName",
                T0."Phone1",
                T0."Phone2",
                T0."U_jshshir",
                T0."Cellular"
            FROM ${this.db}.OCRD T0
            WHERE
                (${jshshir ? `T0."U_jshshir" = '${jshshir}'` : '1=0'})
               OR (${passport ? `T0."Cellular" = '${passport}'` : '1=0'})
        `;
    }

    getInstallmentPaymentsByPerson(cardCode) {
        return `
WITH base_bp AS (
  SELECT
    NULLIF(TRIM(BP."U_jshshir"), '') AS "U_jshshir",
    NULLIF(TRIM(BP."Cellular"), '')  AS "Cellular"
  FROM ${this.db}.OCRD BP
  WHERE BP."CardCode" = '${cardCode}'
  LIMIT 1
),
bp_codes AS (
  SELECT BP2."CardCode"
  FROM ${this.db}.OCRD BP2
  CROSS JOIN base_bp B
  WHERE B."U_jshshir" IS NOT NULL
    AND TRIM(BP2."U_jshshir") = B."U_jshshir"

  UNION

  SELECT BP3."CardCode"
  FROM ${this.db}.OCRD BP3
  CROSS JOIN base_bp B
  WHERE B."U_jshshir" IS NULL
    AND B."Cellular" IS NOT NULL
    AND TRIM(BP3."Cellular") = B."Cellular"
)

SELECT
  T0."DocEntry",
  T0."CardCode",
  T1."DueDate",
  T1."InsTotal",
  T1."InstlmntID",

  -- bu ikkisi aslida SUM emas, lekin sizda shunaqa bo'lgani uchun qoldirdim:
  (SELECT SUM(A1."DocTotal")
   FROM ${this.db}.OINV A1
   WHERE A1."DocEntry" = T0."DocEntry" AND A1."CANCELED" = 'N') AS "Total",

  (SELECT SUM(A1."PaidToDate")
   FROM ${this.db}.OINV A1
   WHERE A1."DocEntry" = T0."DocEntry" AND A1."CANCELED" = 'N') AS "TotalPaid",

  COALESCE(SUM(T2."SumApplied"), 0) AS "SumApplied",
  MAX(T3."DocDate")  AS "DocDate",
  MAX(T3."Canceled") AS "Canceled"

FROM ${this.db}.INV6 T1
INNER JOIN ${this.db}.OINV T0
  ON T0."DocEntry" = T1."DocEntry"

LEFT JOIN ${this.db}.RCT2 T2
  ON T2."DocEntry" = T0."DocEntry"
 AND T2."InstId"    = T1."InstlmntID"

LEFT JOIN ${this.db}.ORCT T3
  ON T3."DocEntry" = T2."DocNum"

WHERE
  T0."CANCELED" = 'N'
  AND T0."CardCode" IN (SELECT "CardCode" FROM bp_codes)

  -- CreditMemo (ORIN/RIN1) bilan yopilgan invoice'larni chiqarib tashlash
  AND NOT EXISTS (
    SELECT 1
    FROM ${this.db}.RIN1 CM1
    INNER JOIN ${this.db}.ORIN CM0
      ON CM0."DocEntry" = CM1."DocEntry"
    WHERE CM1."BaseType"  = 13
      AND CM1."BaseEntry" = T0."DocEntry"
  )

GROUP BY
  T0."DocEntry",
  T0."CardCode",
  T1."InstlmntID",
  T1."DueDate",
  T1."InsTotal"

ORDER BY
  T0."DocEntry",
  T1."InstlmntID"
  `;
    }


    // getInstallmentPayments(cardCode) {
    //     return `
    //        SELECT
    //             T0."DocEntry",
    //             T0."CardCode",
    //             T1."DueDate",
    //             T1."InsTotal",
    //             T1."InstlmntID",
    //             (Select SUM(A1."DocTotal") FROM ${this.db}.OINV A1  WHERE  T0."DocEntry" = A1."DocEntry" and  A1."CANCELED" = 'N') as "Total",
    //             (Select SUM(A1."PaidToDate") FROM ${this.db}.OINV A1  WHERE T0."DocEntry" = A1."DocEntry" and A1."CANCELED" = 'N') as "TotalPaid",
    //             SUM(T2."SumApplied") as "SumApplied",
    //             MAX(T3."DocDate") as "DocDate",
    //             T3."Canceled"
    //         FROM ${this.db}.INV6 T1
    //         INNER JOIN ${this.db}.OINV T0 ON T0."DocEntry" = T1."DocEntry"
    //          LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry"= T0."DocEntry"
    //             AND T1."InstlmntID" = T2."InstId"
    //          LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry"
    //         WHERE
    //             T0."CardCode" = '${cardCode}' and T0."CANCELED" = 'N'
    //           AND NOT EXISTS (
    //             SELECT 1
    //             FROM ${this.db}.RIN1 CM1
    //                      INNER JOIN ${this.db}.ORIN CM0
    //                                 ON CM0."DocEntry" = CM1."DocEntry"
    //             WHERE CM1."BaseType" = 13              -- A/R Invoice
    //               AND CM1."BaseEntry" = T0."DocEntry"
    //         )
    //         GROUP BY
    //             T1."InstlmntID",
    //             T0."DocEntry",
    //             T0."CardCode",
    //             T1."DueDate",
    //             T1."InsTotal",
    //             T3."DocDate",
    //             T3."Canceled"
    //         ORDER BY
    //             T0."DocEntry",
    //             T1."InstlmntID";
    //     `;
    // }

    getDistribution({ startDate, endDate, }) {
        let statusCondition = 'AND ((T0."PaidToDate" = 0) OR (T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal"))';
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

    getItemSeries({ itemCode, whsCode, priceList = 1 }) {
        const whsFilter = whsCode ? `AND Q."WhsCode" = '${whsCode}'` : '';

        return `
    WITH serials AS (
      SELECT
        R."ItemCode",
        R."DistNumber" AS "IMEI",
        R."SysNumber",
        Q."WhsCode",
        Q."Quantity"
      FROM ${this.db}."OSRN" R
      JOIN ${this.db}."OSRQ" Q
        ON Q."ItemCode" = R."ItemCode"
       AND Q."SysNumber" = R."SysNumber"
       ${whsFilter}
      WHERE
        R."ItemCode" = '${itemCode}'
        AND Q."Quantity" > 0
    ),
    ap_last AS (
      SELECT
        S."ItemCode",
        S."SysNumber",

        P1."Price" AS "PurchasePrice",
        P1."U_battery_capacity" AS "Battery",

        ROW_NUMBER() OVER (
          PARTITION BY S."ItemCode", S."SysNumber"
          ORDER BY H."DocDate" DESC, H."DocEntry" DESC
        ) AS rn
      FROM serials S
      JOIN ${this.db}."SRI1" T
        ON T."ItemCode" = S."ItemCode"
       AND T."SysSerial" = S."SysNumber"
      JOIN ${this.db}."OPCH" H
        ON H."DocEntry" = T."BaseEntry"
      JOIN ${this.db}."PCH1" P1
        ON P1."DocEntry" = T."BaseEntry"
       AND P1."LineNum"  = T."BaseLinNum"
      WHERE
        T."BaseType" = 18  -- A/P Invoice
    )
    SELECT
      S."ItemCode",
      S."IMEI",
      S."SysNumber",
      S."WhsCode",
      S."Quantity",

      PR."Price" AS "SalePrice",
      COUNT(*) OVER() AS "TotalCount",

      A."PurchasePrice",
      A."Battery"

    FROM serials S

    LEFT JOIN ap_last A
      ON A."ItemCode"  = S."ItemCode"
     AND A."SysNumber" = S."SysNumber"
     AND A.rn = 1

    LEFT JOIN ${this.db}."ITM1" PR
      ON PR."ItemCode" = S."ItemCode"
     AND PR."PriceList" = ${priceList}

    ORDER BY S."IMEI";
  `;
    }


    // 352820546993929
    getItems({ search, filters = {}, limit = 50, offset = 0, whsCode }) {
        let whereClauses = ['1=1', `T0."OnHand" > 0`];
        let imeiJoin = '';
        let imeiWhere = '';

        const isIMEI = search && /^\d+$/.test(search) && search.length >= 4;

        // Warehouse filter
        if (whsCode) whereClauses.push(`T0."WhsCode" = '${whsCode}'`);

        if (isIMEI) {
            const whsCondition = whsCode ? `AND Q."WhsCode" = '${whsCode}'` : ``;

            imeiJoin = `
      LEFT JOIN ${this.db}."OSRN" R
        ON R."ItemCode" = T1."ItemCode"
      LEFT JOIN ${this.db}."OSRQ" Q
        ON Q."ItemCode" = R."ItemCode"
       AND Q."SysNumber" = R."SysNumber"
       ${whsCondition}
    `;

            imeiWhere = `
      AND R."DistNumber" LIKE '%${search}%'
      AND Q."Quantity" > 0
    `;
        } else if (search) {
            const s = search.toLowerCase();
            whereClauses.push(`
      (
        LOWER(T1."ItemCode") LIKE '%${s}%'
        OR LOWER(T1."ItemName") LIKE '%${s}%'
        OR LOWER(T1."U_Model") LIKE '%${s}%'
      )
    `);
        }

        // Filters
        if (filters.model) whereClauses.push(`T1."U_Model" = '${filters.model}'`);
        if (filters.deviceType) whereClauses.push(`T1."U_DeviceType" = '${filters.deviceType}'`);
        if (filters.memory) whereClauses.push(`T1."U_Memory" = '${filters.memory}'`);
        if (filters.simType) whereClauses.push(`T1."U_Sim_type" = '${filters.simType}'`);
        if (filters.condition) whereClauses.push(`T1."U_PROD_CONDITION" = '${filters.condition}'`);
        if (filters.color) whereClauses.push(`T1."U_Color" = '${filters.color}'`);

        const whereQuery = 'WHERE ' + whereClauses.join(' AND ') + imeiWhere;

        const imeiSelect = isIMEI ? `R."DistNumber" AS "IMEI",` : '';

        // ✅ total hisoblash uchun DISTINCT nima bo‘lishini tanlang:
        // - IMEI qidiruvda: bitta serial = bitta row → DistNumber bo‘yicha
        // - Oddiy listda: bitta item+warehouse = bitta row → ItemCode+WhsCode bo‘yicha
        const distinctExpr = isIMEI
            ? `R."DistNumber"`
            : `T0."ItemCode" || ':' || T0."WhsCode"`; // HANA string concat: ||

        const baseFrom = `
    FROM ${this.db}."OITW" T0
      INNER JOIN ${this.db}."OITM" T1 ON T0."ItemCode" = T1."ItemCode"
      INNER JOIN ${this.db}."OWHS" T2 ON T0."WhsCode" = T2."WhsCode"
      ${imeiJoin}
      LEFT JOIN ${this.db}."ITM1" PR
        ON PR."ItemCode" = T1."ItemCode"
       AND PR."PriceList" = 1
    ${whereQuery}
  `;

        const dataSql = `
    SELECT
      ${imeiSelect}
      T0."ItemCode",
      T0."WhsCode",
      CAST(T0."OnHand" AS INTEGER) AS "OnHand",
      T1."ItemName",
      T1."U_Color",
      T1."U_Condition",
      T1."U_Model",
      T1."U_DeviceType",
      T1."U_Memory",
      T1."U_Sim_type",
      T1."U_PROD_CONDITION",
      T2."WhsName",
      PR."Price" AS "SalePrice",
      ${isIMEI ? `R."CostTotal" AS "PurchasePrice"` : `NULL AS "PurchasePrice"`}
    ${baseFrom}
    ORDER BY 
     T1."U_Model" DESC
    LIMIT ${limit}
    OFFSET ${offset};
  `;

        const countSql = `
    SELECT COUNT(DISTINCT ${distinctExpr}) AS "total"
    ${baseFrom};
  `;

        return { dataSql, countSql };
    }


    getAllHighLimitCandidatesByCardCode() {
        return `
WITH bp AS (
  SELECT
    BP."CardCode",
    BP."CardName",
    NULLIF(TRIM(BP."U_jshshir"), '') AS "jshshir",
    NULLIF(TRIM(BP."Cellular"), '')  AS "cellular_raw",
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Cellular"), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') AS "cellular_norm",
    CASE
      WHEN NULLIF(TRIM(BP."U_jshshir"), '') IS NOT NULL THEN TRIM(BP."U_jshshir")
      WHEN NULLIF(TRIM(BP."Cellular"), '') IS NOT NULL THEN
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Cellular"), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
      ELSE NULL
    END AS "person_key"
  FROM ${this.db}."OCRD" BP
  WHERE BP."CardType" = 'C' and BP."U_blocked" = 'no'
),
bp_person AS (
  SELECT *
  FROM bp
  WHERE "person_key" IS NOT NULL
),
person_main AS (
  SELECT
    "person_key",
    MIN("CardCode") AS "CardCode",
    MAX("CardName") AS "CardName"
  FROM bp_person
  GROUP BY "person_key"
),
inv_base AS (
  SELECT
    I."DocEntry",
    I."CardCode",
    I."DocTotal",
    I."PaidToDate"
  FROM ${this.db}."OINV" I
  WHERE I."CANCELED" = 'N'
    -- CreditMemo bilan yopilgan invoice'larni chiqarib tashlash
    AND NOT EXISTS (
      SELECT 1
      FROM ${this.db}."RIN1" CM1
      INNER JOIN ${this.db}."ORIN" CM0 ON CM0."DocEntry" = CM1."DocEntry"
      WHERE CM1."BaseType"  = 13
        AND CM1."BaseEntry" = I."DocEntry"
    )
),
inst_payments AS (
  SELECT
    P."person_key",
    I."CardCode",
    I."DocEntry",
    S."InstlmntID",
    S."DueDate",
    S."InsTotal",
    I."DocTotal"    AS "InvoiceTotal",
    I."PaidToDate"  AS "InvoicePaidToDate",

    COALESCE(SUM(R2."SumApplied"), 0) AS "SumApplied",
    MAX(R0."DocDate") AS "LastPayDate"
  FROM bp_person P
  INNER JOIN inv_base I ON I."CardCode" = P."CardCode"
  INNER JOIN ${this.db}."INV6" S ON S."DocEntry" = I."DocEntry"

  LEFT JOIN ${this.db}."RCT2" R2
    ON R2."DocEntry" = I."DocEntry"
   AND R2."InstId"   = S."InstlmntID"

  LEFT JOIN ${this.db}."ORCT" R0
    ON R0."DocEntry" = R2."DocNum"
   AND R0."Canceled" = 'N'

  GROUP BY
    P."person_key",
    I."CardCode",
    I."DocEntry",
    S."InstlmntID",
    S."DueDate",
    S."InsTotal",
    I."DocTotal",
    I."PaidToDate"
),
inst_calc AS (
  SELECT
    A.*,
    CURRENT_DATE AS "Today",
    CASE WHEN A."SumApplied" >= A."InsTotal" THEN 1 ELSE 0 END AS "IsFullyPaid",

    DAYS_BETWEEN(
      A."DueDate",
      CASE
        WHEN A."SumApplied" >= A."InsTotal" AND A."LastPayDate" IS NOT NULL THEN A."LastPayDate"
        ELSE CURRENT_DATE
      END
    ) AS "DelayDays",

    CASE
      WHEN (A."InsTotal" - A."SumApplied") > 0 THEN (A."InsTotal" - A."SumApplied")
      ELSE 0
    END AS "Unpaid"
  FROM inst_payments A
),
inst_scored AS (
  SELECT
    C.*,
    CASE
      WHEN C."DelayDays" <= 0  THEN 10
      WHEN C."DelayDays" <= 6  THEN 9
      WHEN C."DelayDays" <= 12 THEN 8
      WHEN C."DelayDays" <= 18 THEN 7
      WHEN C."DelayDays" <= 24 THEN 6
      WHEN C."DelayDays" <= 30 THEN 5
      WHEN C."DelayDays" <= 36 THEN 4
      WHEN C."DelayDays" <= 42 THEN 3
      WHEN C."DelayDays" <= 48 THEN 2
      WHEN C."DelayDays" <= 54 THEN 1
      ELSE 0
    END AS "DelayScore"
  FROM inst_calc C
),
person_agg AS (
  SELECT
    X."person_key",

    COUNT(DISTINCT X."DocEntry") AS "totalContracts",

    -- openContracts: invoice total > paidtodate + 5
    COUNT(DISTINCT CASE WHEN X."InvoiceTotal" > X."InvoicePaidToDate" + 5 THEN X."DocEntry" ELSE NULL END) AS "openContracts",

    -- Siz JS’da totalAmount += c.Total (OINV.DocTotal), totalPaid += c.PaidTodate (OINV.PaidToDate) qilgansiz.
    -- Shu uchun DocEntry bo‘yicha bitta marta olish:
    SUM(DISTINCT X."InvoiceTotal")      AS "totalAmount",
    SUM(DISTINCT X."InvoicePaidToDate") AS "totalPaid",

    -- overdueDebt: DueDate < today va unpaid>0
    SUM(CASE WHEN X."DueDate" < X."Today" AND X."Unpaid" > 0 THEN X."Unpaid" ELSE 0 END) AS "overdueDebt",

    MAX(X."DelayDays") AS "maxDelay",

    -- avgPaymentDelay: faqat DueDate <= today bo'lgan installmentlar
    AVG(CASE WHEN X."DueDate" <= X."Today" THEN X."DelayDays" ELSE NULL END) AS "avgPaymentDelay",

    AVG(X."DelayScore") AS "score"
  FROM inst_scored X
  GROUP BY X."person_key"
),
scoring AS (
  SELECT
    P.*,

    CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END AS "paidRatio",
    CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END AS "overRate",

    -- hScore (avgPaymentDelay blok)
    CASE
      WHEN P."avgPaymentDelay" <= 0  THEN 10
      WHEN P."avgPaymentDelay" <= 2  THEN 9
      WHEN P."avgPaymentDelay" <= 4  THEN 8
      WHEN P."avgPaymentDelay" <= 6  THEN 7
      WHEN P."avgPaymentDelay" <= 8  THEN 6
      WHEN P."avgPaymentDelay" <= 10 THEN 5
      WHEN P."avgPaymentDelay" <= 12 THEN 4
      WHEN P."avgPaymentDelay" <= 14 THEN 3
      WHEN P."avgPaymentDelay" <= 16 THEN 2
      WHEN P."avgPaymentDelay" <= 18 THEN 1
      WHEN P."avgPaymentDelay" <= 20 THEN 0
      WHEN P."avgPaymentDelay" <= 22 THEN -3
      WHEN P."avgPaymentDelay" <= 24 THEN -6
      WHEN P."avgPaymentDelay" <= 26 THEN -9
      WHEN P."avgPaymentDelay" <= 28 THEN -12
      WHEN P."avgPaymentDelay" <= 30 THEN -15
      ELSE -20
    END AS "hScore",

    -- gScore (maxDelay blok)
    CASE
      WHEN P."maxDelay" <= 2  THEN 15
      WHEN P."maxDelay" <= 4  THEN 14
      WHEN P."maxDelay" <= 6  THEN 13
      WHEN P."maxDelay" <= 8  THEN 12
      WHEN P."maxDelay" <= 10 THEN 11
      WHEN P."maxDelay" <= 12 THEN 10
      WHEN P."maxDelay" <= 14 THEN 9
      WHEN P."maxDelay" <= 16 THEN 8
      WHEN P."maxDelay" <= 18 THEN 7
      WHEN P."maxDelay" <= 20 THEN 6
      WHEN P."maxDelay" <= 22 THEN 5
      WHEN P."maxDelay" <= 24 THEN 4
      WHEN P."maxDelay" <= 26 THEN 3
      WHEN P."maxDelay" <= 28 THEN 2
      WHEN P."maxDelay" <= 30 THEN 1
      ELSE -5
    END AS "gScore",

    -- overScore (overdue rate blok)
    CASE
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) = 0 THEN 15
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) <= 0.01 THEN 12
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) <= 0.03 THEN 6
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) <= 0.05 THEN 2
      ELSE 0
    END AS "overScore",

    -- paidScore (paid ratio blok)
    CASE
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.95 THEN 15
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.9  THEN 14
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.85 THEN 13
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.8  THEN 12
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.75 THEN 11
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.7  THEN 10
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.65 THEN 9
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.6  THEN 8
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.55 THEN 7
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.5  THEN 6
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.45 THEN 5
      WHEN (CASE WHEN P."totalAmount" > 0 THEN P."totalPaid" / P."totalAmount" ELSE 0 END) >= 0.4  THEN 4
      ELSE 0
    END AS "paidScore",

    -- openScore (openContracts/totalContracts)
    CASE
      WHEN (CASE WHEN P."totalContracts" > 0 THEN P."openContracts" / P."totalContracts" ELSE 0 END) <= 0.34 THEN 5
      WHEN (CASE WHEN P."totalContracts" > 0 THEN P."openContracts" / P."totalContracts" ELSE 0 END) <= 0.6  THEN 3
      WHEN (CASE WHEN P."totalContracts" > 0 THEN P."openContracts" / P."totalContracts" ELSE 0 END) <= 0.8  THEN 1
      ELSE 0
    END AS "openScore"

  FROM person_agg P
),
final_calc AS (
  SELECT
    S.*,

    (40 * (S."score" / 10)) + S."hScore" + S."gScore" + S."overScore" + S."paidScore" + S."openScore" AS "rawScore",

    CASE
      WHEN S."totalPaid" = 0 AND S."overdueDebt" = 0 THEN 30
      WHEN S."openContracts" >= 3 THEN LEAST(30, (40 * (S."score" / 10)) + S."hScore" + S."gScore" + S."overScore" + S."paidScore" + S."openScore")
      WHEN S."openContracts" = 2 THEN LEAST(50, (40 * (S."score" / 10)) + S."hScore" + S."gScore" + S."overScore" + S."paidScore" + S."openScore")
      ELSE (40 * (S."score" / 10)) + S."hScore" + S."gScore" + S."overScore" + S."paidScore" + S."openScore"
    END AS "baseFinal",

    CASE
      WHEN S."paidRatio" >= 0.9 THEN 0
      WHEN S."paidRatio" >= 0.8 THEN 5
      WHEN S."paidRatio" >= 0.7 THEN 10
      WHEN S."paidRatio" >= 0.6 THEN 15
      ELSE 20
    END AS "penalty"
  FROM scoring S
),
limits AS (
  SELECT
    F.*,
    FLOOR(F."baseFinal" - F."penalty") AS "internalScore",

    CASE
      WHEN F."overRate" >= 0.03 OR F."overdueDebt" >= 3000000 OR F."maxDelay" >= 51 THEN 'Xavfli'
      ELSE 'Xavfsiz'
    END AS "trustLabel",

    CASE
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 85 THEN 30000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 84 THEN 29000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 83 THEN 28000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 82 THEN 27000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 81 THEN 26000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 80 THEN 25000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 79 THEN 24000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 78 THEN 23000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 77 THEN 22000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 76 THEN 21000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 75 THEN 20000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 74 THEN 19000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 73 THEN 18000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 72 THEN 17000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 71 THEN 16000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 70 THEN 15000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 69 THEN 14000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 68 THEN 13000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 67 THEN 12000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 66 THEN 11000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 65 THEN 10000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 64 THEN 9000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 63 THEN 8000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 62 THEN 7000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 61 THEN 6000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 60 THEN 5000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 55 THEN 4000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 50 THEN 3000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 45 THEN 2000000
      WHEN FLOOR(F."baseFinal" - F."penalty") >= 40 THEN 1000000
      ELSE 0
    END AS "limitRaw"
  FROM final_calc F
)

SELECT
  PM."CardCode" AS "CardCode",
  PM."CardName" AS "CardName",

  L."score",
  L."totalContracts",
  L."openContracts",
  L."totalAmount",
  L."totalPaid",
  L."overdueDebt",
  L."maxDelay",
  FLOOR(L."avgPaymentDelay") AS "avgPaymentDelay",

  L."internalScore",
  L."trustLabel",

  CASE
    WHEN LOWER(L."trustLabel") = 'xavfli' THEN LEAST(L."limitRaw", 5000000)
    ELSE L."limitRaw"
  END AS "limit",

  FLOOR(
    (CASE
      WHEN LOWER(L."trustLabel") = 'xavfli' THEN LEAST(L."limitRaw", 5000000)
      ELSE L."limitRaw"
    END) / 12
  ) AS "monthlyLimit"

FROM limits L
JOIN person_main PM ON PM."person_key" = L."person_key"

WHERE
  (CASE
    WHEN LOWER(L."trustLabel") = 'xavfli' THEN LEAST(L."limitRaw", 5000000)
    ELSE L."limitRaw"
  END) = 30000000

ORDER BY "limit" DESC
`;
    }


    escapeLike = (v = '') => String(v).replace(/[%_\\]/g, (m) => '\\' + m);

    /**
     * Purchases list (approve=OPCH, pending/rejected=ODRF ObjType=18)
     * - search: DocNum/CardCode/CardName/Comments + IMEI/Serial
     * - dateFrom/dateTo: DocDate filter
     * - status: approve | pending | rejected | null
     * - hide converted drafts (OPCH.draftKey = ODRF.DocEntry) except rejected list
     */
    getPurchases({ search, status, limit = 20, offset = 0, dateFrom, dateTo }) {
        const s = search ? this.escapeLike(search.trim().toLowerCase()) : null;
        const searchLike = s ? `%${s}%` : null;

        const normalizedStatus =
            status === 'approve' || status === 'pending' || status === 'rejected'
                ? status
                : null;

        const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
        const normalizedOffset = Math.max(0, Number(offset) || 0);

        // Param order for both queries (very important):
        // 1) dateFrom, 2) dateTo, 3) searchLike, 4) status, 5) limit, 6) offset
        const baseParams = [
            dateFrom || null,
            dateTo || null,
            searchLike,
            normalizedStatus,
        ];

        const baseUnion = `
WITH
params AS (
  SELECT
    CAST(? AS NVARCHAR(20))  AS "dateFrom",
    CAST(? AS NVARCHAR(20))  AS "dateTo",
    CAST(? AS NVARCHAR(200)) AS "searchLike",
    CAST(? AS NVARCHAR(20))  AS "status"
  FROM DUMMY
),

docs AS (
  SELECT
    'doc'      AS "source",
    'approve'  AS "status",
    H."DocEntry"  AS "docEntry",
    H."DocNum"    AS "docNum",
    H."DocDate"   AS "docDate",
    H."DocDueDate" AS "docDueDate",
    H."CardCode"  AS "cardCode",
    H."CardName"  AS "cardName",
    H."DocCur"    AS "docCur",
    H."DocRate"   AS "docRate",
    H."DocTotal"  AS "docTotal",
    H."Comments"  AS "comments"
  FROM ${this.db}."OPCH" H
  CROSS JOIN params P
  WHERE
    H."CANCELED" = 'N'
    AND (P."dateFrom" IS NULL OR H."DocDate" >= P."dateFrom")
    AND (P."dateTo"   IS NULL OR H."DocDate" <= P."dateTo")
    AND (
      P."status" IS NULL OR P."status" = '' OR P."status" = 'approve'
    )
    AND (
      P."searchLike" IS NULL
      OR LOWER(CAST(H."DocNum" AS NVARCHAR(50))) LIKE P."searchLike" ESCAPE '\\'
      OR LOWER(IFNULL(H."CardCode", ''))         LIKE P."searchLike" ESCAPE '\\'
      OR LOWER(IFNULL(H."CardName", ''))         LIKE P."searchLike" ESCAPE '\\'
      OR LOWER(IFNULL(H."Comments", ''))         LIKE P."searchLike" ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM ${this.db}."PCH1" L
        JOIN ${this.db}."SRI1" R
          ON R."BaseType"   = 18
         AND R."BaseEntry"  = L."DocEntry"
         AND R."BaseLinNum" = L."LineNum"
         AND R."ItemCode"   = L."ItemCode"
        JOIN ${this.db}."OSRI" S
          ON S."SysSerial" = R."SysSerial"
         AND S."ItemCode"  = R."ItemCode"
        WHERE L."DocEntry" = H."DocEntry"
          AND LOWER(IFNULL(S."IntrSerial", '')) LIKE P."searchLike" ESCAPE '\\'
      )
    )
),

drafts AS (
  SELECT
    'draft' AS "source",
    CASE WHEN D."CANCELED"='Y' THEN 'rejected' ELSE 'pending' END AS "status",
    D."DocEntry" AS "docEntry",
    D."DocNum"   AS "docNum",
    D."DocDate"  AS "docDate",
    D."DocDueDate" AS "docDueDate",
    D."CardCode" AS "cardCode",
    D."CardName" AS "cardName",
    D."DocCur"   AS "docCur",
    D."DocRate"  AS "docRate",
    D."DocTotal" AS "docTotal",
    D."Comments" AS "comments"
  FROM ${this.db}."ODRF" D
  CROSS JOIN params P
  WHERE
    D."ObjType" = 18
    AND (P."dateFrom" IS NULL OR D."DocDate" >= P."dateFrom")
    AND (P."dateTo"   IS NULL OR D."DocDate" <= P."dateTo")
    AND (
      P."status" IS NULL OR P."status" = ''
      OR (P."status"='pending'  AND D."CANCELED"='N')
      OR (P."status"='rejected' AND D."CANCELED"='Y')
    )
    -- hide converted drafts except in rejected list
    AND (
      P."status" = 'rejected'
      OR NOT EXISTS (
        SELECT 1
        FROM ${this.db}."OPCH" X
        WHERE X."CANCELED" = 'N'
          AND X."draftKey" = D."DocEntry"
      )
    )
    AND (
      P."searchLike" IS NULL
      OR LOWER(CAST(D."DocNum" AS NVARCHAR(50))) LIKE P."searchLike" ESCAPE '\\'
      OR LOWER(IFNULL(D."CardCode", ''))         LIKE P."searchLike" ESCAPE '\\'
      OR LOWER(IFNULL(D."CardName", ''))         LIKE P."searchLike" ESCAPE '\\'
      OR LOWER(IFNULL(D."Comments", ''))         LIKE P."searchLike" ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM ${this.db}."DRF1" L
        WHERE L."DocEntry" = D."DocEntry"
          AND LOWER(IFNULL(L."U_series", '')) LIKE P."searchLike" ESCAPE '\\'
      )
    )
),

unioned AS (
  SELECT * FROM docs
  UNION ALL
  SELECT * FROM drafts
)
SELECT * FROM unioned
`;

        const countSql = `
SELECT COUNT(*) AS "total"
FROM (
  ${baseUnion}
) Z
`;

        const dataSql = `
SELECT
  Q.*,
  COUNT(*) OVER() AS "total"
FROM (
  ${baseUnion}
) Q
ORDER BY Q."docDate" DESC, Q."docEntry" DESC
LIMIT ? OFFSET ?
`;

        const dataParams = [...baseParams, normalizedLimit, normalizedOffset];
        const countParams = [...baseParams];

        return { dataSql, dataParams, countSql, countParams };
    }

    /**
     * Purchase detail
     * - source: 'doc' | 'draft'
     * - docEntry: number
     * Doc lines:
     *  - doc: OSRI.IntrSerial (real serial)
     *  - draft: DRF1.U_series (temporary serial)
     */
    getPurchaseDetail({ source, docEntry }) {
        const isDoc = String(source) === 'doc';
        const docEntryNum = Number(docEntry);

        if (!Number.isFinite(docEntryNum) || docEntryNum <= 0) {
            throw new Error('docEntry must be positive number');
        }

        const headerTable = isDoc ? `${this.db}."OPCH"` : `${this.db}."ODRF"`;
        const linesTable  = isDoc ? `${this.db}."PCH1"` : `${this.db}."DRF1"`;

        const headerSql = `
SELECT
  ? AS "source",
  ${
            isDoc
                ? `? AS "status"`
                : `CASE WHEN H."CANCELED"='Y' THEN 'rejected' ELSE 'pending' END AS "status"`
        },
  H."DocEntry" AS "docEntry",
  H."DocNum" AS "docNum",
  H."DocDate" AS "docDate",
  H."DocDueDate" AS "docDueDate",
  H."CardCode" AS "cardCode",
  H."CardName" AS "cardName",
  H."DocCur" AS "docCur",
  H."DocRate" AS "docRate",
  H."DocTotal" AS "docTotal",
  H."Comments" AS "comments"
FROM ${headerTable} H
WHERE
  ${
            isDoc ? `H."CANCELED"='N'` : `H."ObjType"=18`
        }
  AND H."DocEntry" = ?
`;

        const headerParams = isDoc
            ? ['doc', 'approve', docEntryNum]
            : ['draft', docEntryNum];

        const linesSql = isDoc
            ? `
SELECT
  L."DocEntry" AS "docEntry",
  L."LineNum"  AS "lineNum",
  L."ItemCode" AS "itemCode",
  L."Dscription" AS "dscription",
  L."WhsCode"  AS "whsCode",
  L."Price"    AS "price",
  L."LineTotal" AS "lineTotal",
  L."Quantity" AS "lineQuantity",
  I."ManSerNum" AS "isSerialManaged",
  S."IntrSerial" AS "serial",
  L."U_battery_capacity" AS "batteryCapacity",
  COALESCE(L."U_PROD_CONDITION", I."U_PROD_CONDITION") AS "prodCondition"
FROM ${linesTable} L
JOIN ${this.db}."OITM" I
  ON I."ItemCode" = L."ItemCode"
LEFT JOIN ${this.db}."SRI1" R
  ON R."BaseType"   = 18
 AND R."BaseEntry"  = L."DocEntry"
 AND R."BaseLinNum" = L."LineNum"
 AND R."ItemCode"   = L."ItemCode"
LEFT JOIN ${this.db}."OSRI" S
  ON S."SysSerial" = R."SysSerial"
 AND S."ItemCode"  = R."ItemCode"
WHERE
  L."DocEntry" = ?
ORDER BY
  L."LineNum" ASC,
  S."IntrSerial" ASC
`
            : `
SELECT
  L."DocEntry" AS "docEntry",
  L."LineNum"  AS "lineNum",
  L."ItemCode" AS "itemCode",
  L."Dscription" AS "dscription",
  L."WhsCode"  AS "whsCode",
  L."Price"    AS "price",
  L."LineTotal" AS "lineTotal",
  L."Quantity" AS "lineQuantity",
  I."ManSerNum" AS "isSerialManaged",
  L."U_series" AS "serial",
  L."U_battery_capacity" AS "batteryCapacity",
  COALESCE(L."U_PROD_CONDITION", I."U_PROD_CONDITION") AS "prodCondition"
FROM ${linesTable} L
JOIN ${this.db}."OITM" I
  ON I."ItemCode" = L."ItemCode"
WHERE
  L."DocEntry" = ?
ORDER BY
  L."LineNum" ASC
`;

        const linesParams = [docEntryNum];

        return {
            headerSql,
            headerParams,
            dataSql: linesSql,
            dataParams: linesParams,
        };
    }





}

module.exports = new DataRepositories(db);