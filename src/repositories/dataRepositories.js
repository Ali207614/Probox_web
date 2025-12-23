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
                    WHERE CM1."BaseType" = 13              -- A/R Invoice
                      AND CM1."BaseEntry" = T1."DocEntry"  -- shu invoice
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
                  AND CM1."BaseEntry" = T1."DocEntry"  -- shu invoice
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
                  AND CM1."BaseEntry" = T1."DocEntry"  -- shu invoice
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
                  AND CM1."BaseEntry" = T1."DocEntry"  -- shu invoice
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
                      AND CM1."BaseEntry" = T1."DocEntry"  -- shu invoice
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
              AND CM1."BaseEntry" = T1."DocEntry"  -- shu invoice
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

    getInstallmentPayments(cardCode) {
        return `
           SELECT 
                T0."DocEntry",
                T0."CardCode",
                T1."DueDate",
                T1."InsTotal",
                T1."InstlmntID",
                (Select SUM(A1."DocTotal") FROM ${this.db}.OINV A1  WHERE  T0."DocEntry" = A1."DocEntry" and  A1."CANCELED" = 'N') as "Total",
                (Select SUM(A1."PaidToDate") FROM ${this.db}.OINV A1  WHERE T0."DocEntry" = A1."DocEntry" and A1."CANCELED" = 'N') as "TotalPaid",
                SUM(T2."SumApplied") as "SumApplied",
                MAX(T3."DocDate") as "DocDate",
                T3."Canceled"
            FROM ${this.db}.INV6 T1
            INNER JOIN ${this.db}.OINV T0 ON T0."DocEntry" = T1."DocEntry"
             LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry"= T0."DocEntry" 
                AND T1."InstlmntID" = T2."InstId"
             LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry"
            WHERE 
                T0."CardCode" = '${cardCode}' and T0."CANCELED" = 'N'
              AND NOT EXISTS (
                SELECT 1
                FROM ${this.db}.RIN1 CM1
                         INNER JOIN ${this.db}.ORIN CM0
                                    ON CM0."DocEntry" = CM1."DocEntry"
                WHERE CM1."BaseType" = 13              -- A/R Invoice
                  AND CM1."BaseEntry" = T0."DocEntry"  -- shu invoice
            )
            GROUP BY 
                T1."InstlmntID",
                T0."DocEntry",
                T0."CardCode",
                T1."DueDate",
                T1."InsTotal",
                T3."DocDate",
                T3."Canceled"
            ORDER BY
                T0."DocEntry",
                T1."InstlmntID";
        `;
    }

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
        return `
            SELECT
                R."ItemCode",
                R."DistNumber" AS "IMEI",
                R."SysNumber",
                Q."WhsCode",
                Q."Quantity",

                -- Sotuv narxi Price List
                PR."Price" AS "SalePrice",

                -- IMEI bo‘yicha REAL zakup narxi (OSRN.CostTotal)
                R."CostTotal" AS "PurchasePrice"

            FROM ${this.db}."OSRN" R

                     JOIN ${this.db}."OSRQ" Q
                          ON Q."ItemCode" = R."ItemCode"
                              AND Q."SysNumber" = R."SysNumber"
                              AND Q."WhsCode" = '${whsCode}'

                -- PriceList
                     LEFT JOIN ${this.db}."ITM1" PR
                               ON PR."ItemCode" = R."ItemCode"
                                   AND PR."PriceList" = ${priceList}

            WHERE
                R."ItemCode" = '${itemCode}'
              AND Q."Quantity" > 0

            ORDER BY R."DistNumber";
        `;
    }

    // 352820546993929

    getItems({
                 search,
                 filters = {},
                 limit = 50,
                 offset = 0,
                 whsCode
             }) {
        let whereClauses = ['1=1', `T0."OnHand" > 0`];
        let imeiJoin = '';
        let imeiWhere = '';

        const isIMEI = search && /^\d+$/.test(search) && search.length >= 4;

        // Warehouse filter
        if (whsCode) {
            whereClauses.push(`T0."WhsCode" = '${whsCode}'`);
        }

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
        }

        else if (search) {
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

        return `
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

            -- Sale Price (Price List)
            PR."Price" AS "SalePrice",

            -- IMEI bo'yicha real zakup narxi (OSRN.CostTotal)
            ${isIMEI ? `R."CostTotal" AS "PurchasePrice"` : `NULL AS "PurchasePrice"`}

        FROM ${this.db}."OITW" T0
            INNER JOIN ${this.db}."OITM" T1
                ON T0."ItemCode" = T1."ItemCode"
            INNER JOIN ${this.db}."OWHS" T2
                ON T0."WhsCode" = T2."WhsCode"

            ${imeiJoin}

        -- PRICE LIST
        LEFT JOIN ${this.db}."ITM1" PR
            ON PR."ItemCode" = T1."ItemCode"
           AND PR."PriceList" = 1

        ${whereQuery}

        ORDER BY CAST(T0."OnHand" AS INTEGER) DESC
        LIMIT ${limit}
        OFFSET ${offset};
    `;
    }
}

module.exports = new DataRepositories(db);