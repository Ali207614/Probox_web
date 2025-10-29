const moment = require('moment');
const { db } = require('../config');

class DataRepositories {
    constructor(dbName) {
        this.db = dbName;
    }

    getSalesManager({ login = '', password = '' }) {
        return `
        SELECT T0."SlpCode", T0."SlpName", T0."GroupCode", T0."Telephone", T0."U_login", T0."U_password",T0."U_role" , T0."U_branch" FROM ${this.db}.OSLP T0 where T0."U_login"= '${login}' and T0."U_password"='${password}'`;
    }

    getInvoice({ startDate, endDate, limit, offset, paymentStatus, cardCode, serial, phone, search, inInv = [], notInv = [], phoneConfiscated, partial }) {

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

    getDistributionInvoice({ startDate, endDate, limit, offset, paymentStatus, cardCode, serial, phone, invoices, search, partial }) {
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

    getInvoiceSearchBPorSeriaDistribution({ startDate, endDate, limit, offset, paymentStatus, search, phone, invoices, partial }) {
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

        console.log(invoices.length)

        if (invoices.length > 0 && false) {
            const condition = invoices.map(item =>
                `(T2."DocEntry" = '${item.DocEntry}' AND T2."InstId" = '${item.InstlmntID}')`
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


       return `SELECT
           sum(T0."InsTotal") as "InsTotal",
           sum(T0."PaidToDate") as "PaidToDate",
            sum(T2."SumApplied") AS "SumApplied"
        FROM 
        ${this.db}.INV6 T0  INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry" 
        LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry"  and T0."InstlmntID" = T2."InstId" 
        LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry"  and T3."Canceled" = 'N'
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}' and T1."CANCELED" = 'N'
        ${salesCondition}
     GROUP BY T2."DocEntry", T2."InstId" , T0."PaidToDate" , T0."InsTotal"
        `
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
            .endOf('month')     // oyni oxiriga olish
            .add(10, 'days')    // 10 kun qo‘shish
            .format('YYYY.MM.DD');


        return `SELECT 
            TO_VARCHAR(T0."DueDate", 'YYYY.MM.DD') AS "DueDate",
            COALESCE(SUM(T2."SumApplied"), 0) AS "SumApplied",
            T0."InsTotal", 
            T0."PaidToDate"
        FROM 
        ${this.db}.INV6 T0  INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry" 
        LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry"  and T0."InstlmntID" = T2."InstId" 
        LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry" and T3."DocDate" BETWEEN T1."DocDate" and '${newEndDate}' and T3."Canceled" = 'N' and T3."DocType" ='C'
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}' and T1."CANCELED" = 'N'  AND T3."DocDate" IS NOT NULL
        ${salesCondition}
        GROUP BY T0."DueDate",   T0."DocEntry",
                       T0."InstlmntID",
                       T0."InsTotal",
                       T0."PaidToDate"
        ORDER BY T0."DueDate"
        `
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
            .endOf('month')     // oyni oxiriga olish
            .add(10, 'days')    // 10 kun qo‘shish
            .format('YYYY.MM.DD');

        return`SELECT 
            T0."DocEntry",
            T0."InstlmntID",
            SUM(T2."SumApplied") as "SumApplied",
            T0."InsTotal", 
           T0."PaidToDate"
        FROM 
        ${this.db}.INV6 T0  INNER JOIN ${this.db}.OINV T1 ON T0."DocEntry" = T1."DocEntry" 
        LEFT JOIN ${this.db}.RCT2 T2 ON T2."DocEntry" = T0."DocEntry"  and T0."InstlmntID" = T2."InstId" 
        LEFT JOIN ${this.db}.ORCT T3 ON T2."DocNum" = T3."DocEntry" and T3."DocDate" BETWEEN T1."DocDate" and '${newEndDate}' and T3."Canceled" = 'N' 
        WHERE T0."DueDate" BETWEEN '${startDate}' AND '${endDate}' and T1."CANCELED" = 'N' AND T3."DocDate" IS NOT NULL  and T3."DocType" ='C'
        ${salesCondition}
                   GROUP BY
                       T0."DocEntry",
                       T0."InstlmntID",
                       T0."InsTotal",
                       T0."PaidToDate"
       
        `
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

}

module.exports = new DataRepositories(db);