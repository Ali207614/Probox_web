const moment = require('moment');
const { db } = require('../config');
const {get} = require("lodash");
const {
    escapeString,
    safeInt,
    safeDate,
    buildInvoiceKeyList,
    filterPaymentStatuses,
} = require('../utils/sql-helpers');

class DataRepositories {
    constructor(dbName) {
        this.db = dbName;
    }



    _buildPaymentStatusCondition(paymentStatus, partial = []) {
        const statuses = filterPaymentStatuses(paymentStatus);
        if (statuses.length === 0) return '';

        const partialKeys = buildInvoiceKeyList(partial);

        // Har bir partial element uchun negatsiya: NOT (DocEntry=.. AND InstlmntID=..)
        const partialNegated = (partial || [])
            .map(p => {
                const de = safeInt(p.DocEntry, 'DocEntry');
                const id = safeInt(p.InstlmntID, 'InstlmntID');
                return `NOT (T0."DocEntry" = ${de} AND T0."InstlmntID" = ${id})`;
            })
            .join(' AND ');

        const conds = [];

        if (statuses.includes('paid')) {
            conds.push(
                partialKeys
                    ? `(T0."PaidToDate" = T0."InsTotal" OR (${partialKeys}))`
                    : `(T0."PaidToDate" = T0."InsTotal")`
            );
        }
        if (statuses.includes('unpaid')) {
            conds.push(`(T0."PaidToDate" = 0)`);
        }
        if (statuses.includes('partial')) {
            conds.push(
                partialNegated
                    ? `(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal" AND (${partialNegated}))`
                    : `(T0."PaidToDate" > 0 AND T0."PaidToDate" < T0."InsTotal")`
            );
        }

        return `AND (${conds.join(' OR ')})`;
    }

    /**
     * Invoys ro'yxati (paginate). Umumiy + distribution holatlari uchun.
     */
    buildInvoiceQuery(params) {
        const {
            startDate,
            endDate,
            limit = 20,
            offset = 0,
            paymentStatus,
            cardCode,
            serial,
            phone,
            search,
            includeInvoices = [],
            excludeInvoices = [],
            partial = [],
        } = params;

        const sd = safeDate(startDate, 'startDate');
        const ed = safeDate(endDate, 'endDate');
        const lim = Math.min(500, Math.max(1, safeInt(limit, 'limit')));
        const off = Math.max(0, safeInt(offset, 'offset'));

        const filters = [];

        const statusCond = this._buildPaymentStatusCondition(paymentStatus, partial);
        if (statusCond) filters.push(statusCond);

        if (cardCode) {
            filters.push(`AND T2."CardCode" = '${escapeString(cardCode)}'`);
        }

        if (serial) {
            const v = escapeString(String(serial).toUpperCase());
            filters.push(`AND UPPER(TOSRI."IntrSerial") LIKE '%${v}%'`);
        }

        if (phone && phone !== '998') {
            const trimmed = String(phone).startsWith('998') && String(phone).length >= 12
                ? String(phone).slice(3)
                : String(phone);
            const v = escapeString(trimmed);
            filters.push(`AND (T2."Phone1" LIKE '%${v}%' OR T2."Phone2" LIKE '%${v}%')`);
        }

        if (search) {
            const v = escapeString(search);
            filters.push(`AND (
                LOWER(TOSRI."IntrSerial") LIKE LOWER('%${v}%')
                OR LOWER(T2."CardName")  LIKE LOWER('%${v}%')
            )`);
        }

        const includeKeys = buildInvoiceKeyList(includeInvoices);
        const excludeKeys = buildInvoiceKeyList(excludeInvoices);
        if (includeKeys) filters.push(`AND (${includeKeys})`);
        if (excludeKeys) filters.push(`AND NOT (${excludeKeys})`);

        const db = this.db;

        return `
WITH base_data AS (
    SELECT
        T0."DocEntry",
        T0."InstlmntID",
        T1."DocTotal",
        T1."DocTotalFC",
        T1."PaidToDate" AS "DocPaidToDate",
        T1."PaidFC"     AS "DocPaidFC",
        T1."DocCur",
        MAX(T2."CardCode")   AS "CardCode",
        MAX(T2."CardName")   AS "CardName",
        MAX(T3."Dscription") AS "Dscription",
        MAX(T2."Balance")    AS "Balance",
        MAX(T2."Phone1")     AS "Phone1",
        MAX(T2."Phone2")     AS "Phone2",
        MAX(T2."Cellular")   AS "Cellular",
        MAX(T1."Installmnt") AS "Installmnt",
        MAX(T0."DueDate")    AS "DueDate",
        MAX(T0."InsTotal")   AS "InsTotal",
        MAX(T0."InsTotalFC") AS "InsTotalFC",
        MAX(T0."PaidToDate") AS "InstallmentPaidToDate",
        MAX(T0."PaidFC")     AS "InstallmentPaidToDateFC",
        STRING_AGG(TOSRI."IntrSerial", ', ') AS "IntrSerial"
    FROM ${db}.INV6 T0
    INNER JOIN ${db}.OINV T1
        ON T0."DocEntry" = T1."DocEntry"
       AND T1."CardCode" NOT IN ('Naqd','Bonus')
    INNER JOIN ${db}.OCRD T2
        ON T1."CardCode" = T2."CardCode"
    INNER JOIN ${db}.INV1 T3
        ON T1."DocEntry" = T3."DocEntry"
    LEFT JOIN ${db}.SRI1 TSRI1
        ON T3."DocEntry"     = TSRI1."BaseEntry"
       AND TSRI1."BaseType"  = 13
       AND TSRI1."BaseLinNum" = T3."LineNum"
    LEFT JOIN ${db}."OSRI" TOSRI
        ON TSRI1."SysSerial" = TOSRI."SysSerial"
       AND TOSRI."ItemCode"  = TSRI1."ItemCode"
    WHERE T0."DueDate" BETWEEN '${sd}' AND '${ed}'
      AND T1."CANCELED" = 'N'
      AND NOT EXISTS (
          SELECT 1
          FROM ${db}.RIN1 CM1
          INNER JOIN ${db}.ORIN CM0 ON CM0."DocEntry" = CM1."DocEntry"
          WHERE CM1."BaseType"  = 13
            AND CM1."BaseEntry" = T1."DocEntry"
      )
      ${filters.join('\n      ')}
    GROUP BY
        T0."DocEntry", T0."InstlmntID",
        T1."DocTotal", T1."DocTotalFC",
        T1."PaidToDate", T1."PaidFC", T1."DocCur"
)
SELECT
    COUNT(*)                       OVER () AS "TOTAL",
    SUM("InsTotal")                OVER () AS "DocTotal",
    SUM("InstallmentPaidToDate")   OVER () AS "TotalPaidToDate",
    NULL                                    AS "SlpCode",
    "Cellular",
    "CardCode",
    "CardName",
    "Dscription",
    "Balance",
    "Phone1",
    "Phone2",
    "DocTotal"               AS "MaxDocTotal",
    "DocPaidToDate"          AS "MaxTotalPaidToDate",
    "DocCur",
    "DocTotalFC"             AS "MaxDocTotalFC",
    "DocPaidFC"              AS "MaxTotalPaidToDateFC",
    "InstallmentPaidToDateFC" AS "PaidToDateFC",
    "InsTotalFC",
    "InstallmentPaidToDate"  AS "PaidToDate",
    "Installmnt",
    "InstlmntID",
    "DocEntry",
    "DueDate",
    "InsTotal",
    "IntrSerial"
FROM base_data
ORDER BY "DueDate" ASC, "DocEntry" ASC, "InstlmntID" ASC
LIMIT ${lim} OFFSET ${off};
`;
    }

    /**
     * Muddatida undurilish analytics.
     */
    buildAnalyticsQuery(params) {
        const {
            startDate,
            endDate,
            invoices = [],
            excludeInvoices = [],
            isUndistributed = false,
        } = params;

        const sd = safeDate(startDate, 'startDate');
        const ed = safeDate(endDate, 'endDate');

        let includeCondition = '';
        let excludeCondition = '';

        if (!isUndistributed && invoices.length > 0) {
            includeCondition = `AND (${buildInvoiceKeyList(invoices)})`;
        }
        if (isUndistributed && excludeInvoices.length > 0) {
            excludeCondition = `AND NOT (${buildInvoiceKeyList(excludeInvoices)})`;
        }

        const db = this.db;

        return `
SELECT
    COALESCE(SUM(PAY."SumApplied"), 0)  AS "SumApplied",
    COALESCE(SUM(T0."InsTotal"), 0)     AS "InsTotal",
    COALESCE(SUM(T0."PaidToDate"), 0)   AS "PaidToDate"
FROM ${db}.INV6 T0
INNER JOIN ${db}.OINV T1
    ON T0."DocEntry" = T1."DocEntry"
LEFT JOIN (
    SELECT
        R2."DocEntry",
        R2."InstId",
        SUM(R2."SumApplied") AS "SumApplied"
    FROM ${db}.RCT2 R2
    INNER JOIN ${db}.ORCT RCT
        ON RCT."DocEntry" = R2."DocNum"
    WHERE RCT."Canceled" = 'N'
    GROUP BY R2."DocEntry", R2."InstId"
) PAY
    ON PAY."DocEntry" = T0."DocEntry"
   AND PAY."InstId"   = T0."InstlmntID"
WHERE T0."DueDate" BETWEEN '${sd}' AND '${ed}'
  AND T1."CANCELED" = 'N'
  AND T1."CardCode" NOT IN ('Naqd','Bonus')
  AND NOT EXISTS (
      SELECT 1
      FROM ${db}.RIN1 CM1
      INNER JOIN ${db}.ORIN CM0 ON CM0."DocEntry" = CM1."DocEntry"
      WHERE CM1."BaseType"  = 13
        AND CM1."BaseEntry" = T1."DocEntry"
  )
  ${includeCondition}
  ${excludeCondition}
`;
    }

    escapeSqlString = (v = '') => String(v).replace(/'/g, "''");

    getSuppliers({ search = '', limit = 50, offset = 0 } = {}) {
        const hasSearch = String(search || '').trim().length > 0;

        const s = this.escapeSqlString(String(search || '').trim().toLowerCase());
        const like = this.escapeSqlString(`%${this.escapeLike(s)}%`);

        const where = hasSearch
            ? `
      AND (
        LOWER(C."CardCode") LIKE '${like}' ESCAPE '\\'
        OR LOWER(C."CardName") LIKE '${like}' ESCAPE '\\'
        OR LOWER(COALESCE(C."Phone1", '')) LIKE '${like}' ESCAPE '\\'
        OR LOWER(COALESCE(C."Cellular", '')) LIKE '${like}' ESCAPE '\\'
      )
    `
            : '';

        return `
WITH base AS (
  SELECT
    C."CardCode" AS "code",
    C."CardName" AS "name",
    NULLIF(TRIM(C."Phone1"), '')   AS "phone1",
    NULLIF(TRIM(C."Phone2"), '')   AS "phone2",
    NULLIF(TRIM(C."Cellular"), '') AS "cellular",
    NULLIF(TRIM(C."E_Mail"), '')   AS "email",
    NULLIF(TRIM(C."Address"), '')  AS "address",
    C."GroupCode" AS "groupCode",
    C."validFor"  AS "validFor"
  FROM ${this.db}."OCRD" C
  WHERE C."CardType" = 'S'
  ${where}
)
SELECT
  COUNT(*) OVER() AS "total",
  "code",
  "name",
  "phone1",
  "phone2",
  "cellular",
  "email",
  "address",
  "groupCode",
  "validFor"
FROM base
ORDER BY "name" ASC
LIMIT ${Number(limit) || 50}
OFFSET ${Number(offset) || 0};
`;
    }

    getItemGroups({ search = '', limit = 50, offset = 0 } = {}) {
        const hasSearch = String(search || '').trim().length > 0;

        const s = this.escapeSqlString(String(search || '').trim().toLowerCase());
        const like = this.escapeSqlString(`%${this.escapeLike(s)}%`);

        const where = hasSearch
            ? `
      AND (
        LOWER(B."ItmsGrpNam") LIKE '${like}' ESCAPE '\\'
        OR CAST(B."ItmsGrpCod" AS NVARCHAR(20)) LIKE '${like}' ESCAPE '\\'
      )
    `
            : '';

        return `
            WITH base AS (
                SELECT
                    B."ItmsGrpCod" AS "code",
                    B."ItmsGrpNam" AS "name"
                FROM ${this.db}."OITB" B
                WHERE 1=1
                ${where}
                )
            SELECT
                COUNT(*) OVER() AS "total",
                "code",
                "name"
            FROM base
            ORDER BY "name" ASC
                LIMIT ${Number(limit) || 50}
            OFFSET ${Number(offset) || 0};
        `;
    }

    async getSalesManager({ login = '', password = '' }) {
        return `
        SELECT T0."SlpCode", T0."SlpName", T0."GroupCode", T0."Telephone", T0."U_login", T0."U_password",T0."U_role" , T0."U_branch" FROM ${this.db}.OSLP T0 where T0."U_login"= '${login}' and T0."U_password"='${password}'`;
    }

    async getAllSalesManagers() {
        return `
        SELECT T0."SlpCode", T0."SlpName", T0."GroupCode", T0."Telephone", T0."U_login", T0."U_password", T0."U_role", T0."U_branch" FROM ${this.db}.OSLP T0`;
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
            const cleanNumericSearch = search.replace(/[\s+]/g, '');

            searchCondition = `
            AND (
                LOWER(CAST(TOSRI."IntrSerial" AS VARCHAR(100))) LIKE LOWER('%${search}%') OR
                LOWER(CAST(T2."CardName" AS VARCHAR(250))) LIKE LOWER('%${search}%') OR
                CAST(T2."U_jshshir" AS VARCHAR(50)) LIKE '%${cleanNumericSearch}%' OR
                CAST(T2."Cellular" AS VARCHAR(50)) LIKE '%${cleanNumericSearch}%' OR
                CAST(T2."Cellular" AS VARCHAR(50)) LIKE '%${search}%'
            )
            `;
        }

        if (phone && phone !== '998') {
            const trimmedPhone = phone.startsWith('998') && phone.length >= 12 ? phone.slice(3) : phone;

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
            const cleanNumericSearch = search.replace(/[\s+]/g, '');

            searchCondition = `
            AND (
                LOWER(CAST(TOSRI."IntrSerial" AS VARCHAR(100))) LIKE LOWER('%${search}%') OR
                LOWER(CAST(T2."CardName" AS VARCHAR(250))) LIKE LOWER('%${search}%') OR
                CAST(T2."U_jshshir" AS VARCHAR(50)) LIKE '%${cleanNumericSearch}%' OR
                CAST(T2."Cellular" AS VARCHAR(50)) LIKE '%${cleanNumericSearch}%' OR
                CAST(T2."Cellular" AS VARCHAR(50)) LIKE '%${search}%'
            )
            `;
        }

        if (phone && phone !== '998') {
            const trimmedPhone = phone.startsWith('998') && phone.length >= 12 ? phone.slice(3) : phone;

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

    getSalesPersons({ exclude = [], include = [], branch, SlpCode } = {}) {
        let whereClause = `WHERE T0."U_role" IS NOT NULL`;

        if (include.length > 0) {
            whereClause += ` AND T0."U_role" IN (${include.map(r => `'${r}'`).join(', ')})`;
        } else if (exclude.length > 0) {
            whereClause += ` AND T0."U_role" NOT IN (${exclude.map(r => `'${r}'`).join(', ')})`;
        }

        if (branch) {
            whereClause += ` AND T0."U_branch" = '${branch}'`;
        }

        // 📌 Yana bitta shart qo'shamiz: Agar SlpCode kelsa, faqat o'shani qidiradi
        if (SlpCode !== undefined && SlpCode !== null) {
            whereClause += ` AND T0."SlpCode" = ${SlpCode}`; // Agar SAP B1 da SlpCode string bo'lsa, '${SlpCode}' qilib oling
        }

        return `
        SELECT
            T0."SlpCode",
            T0."SlpName",
            T0."U_login",
            T0."U_role",
            T0."U_summa",
            T0."U_workDay",
            T0."U_branch",
            T0."U_onlinepbx"
        FROM ${this.db}.OSLP T0
        ${whereClause}
    `;
    }

    getRate({ currency = 'UZS', date = '' }) {
        const cur = this.sqlStr(currency);

        return `
            SELECT T0."RateDate", T0."Currency", T0."Rate"
            FROM ${this.db}."ORTT" T0
            WHERE T0."Currency" = '${cur}'
            ORDER BY T0."RateDate" DESC
                LIMIT 1
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

    getAnalyticsByDay({ startDate, endDate, invoices = [], phoneConfiscated }) {
        const sd = safeDate(startDate, 'startDate');
        const ed = safeDate(endDate, 'endDate');

        const keys = buildInvoiceKeyList(invoices); // T0."DocEntry"=X AND T0."InstlmntID"=Y OR ...

        let salesCondition = '';
        if (keys) {
            salesCondition = phoneConfiscated === 'true'
                ? `AND NOT (${keys})`
                : `AND (${keys})`;
        }

        const db = this.db;

        return `
SELECT
    TO_VARCHAR(T0."DueDate", 'YYYY.MM.DD')   AS "DueDate",
    COALESCE(SUM(PAY."SumApplied"), 0)       AS "SumApplied",
    COALESCE(SUM(T0."InsTotal"), 0)          AS "InsTotal",
    COALESCE(SUM(T0."PaidToDate"), 0)        AS "PaidToDate"
FROM ${db}.INV6 T0
INNER JOIN ${db}.OINV T1
    ON T0."DocEntry" = T1."DocEntry"
LEFT JOIN (
    SELECT
        R2."DocEntry",
        R2."InstId",
        SUM(R2."SumApplied") AS "SumApplied"
    FROM ${db}.RCT2 R2
    INNER JOIN ${db}.ORCT RCT
        ON RCT."DocEntry" = R2."DocNum"
    WHERE RCT."Canceled" = 'N'
    GROUP BY R2."DocEntry", R2."InstId"
) PAY
    ON PAY."DocEntry" = T0."DocEntry"
   AND PAY."InstId"   = T0."InstlmntID"
WHERE T0."DueDate" BETWEEN '${sd}' AND '${ed}'
  AND T1."CANCELED" = 'N'
  AND T1."CardCode" NOT IN ('Naqd','Bonus')
  AND NOT EXISTS (
      SELECT 1
      FROM ${db}.RIN1 CM1
      INNER JOIN ${db}.ORIN CM0 ON CM0."DocEntry" = CM1."DocEntry"
      WHERE CM1."BaseType"  = 13
        AND CM1."BaseEntry" = T1."DocEntry"
  )
  ${salesCondition}
GROUP BY T0."DueDate"
ORDER BY T0."DueDate"
`;
    }

    getAnalyticsBySlpCode({ startDate, endDate, invoices = [], phoneConfiscated }) {
        const sd = safeDate(startDate, 'startDate');
        const ed = safeDate(endDate, 'endDate');

        const keys = buildInvoiceKeyList(invoices);

        let salesCondition = '';
        if (keys) {
            salesCondition = phoneConfiscated === 'true'
                ? `AND NOT (${keys})`
                : `AND (${keys})`;
        }

        const db = this.db;

        // Bu query qatorma-qator (DocEntry, InstlmntID) darajasida qaytaradi —
        // controller keyin SlpCode bo'yicha yig'adi.
        return `
SELECT
    T0."DocEntry",
    T0."InstlmntID",
    COALESCE(PAY."SumApplied", 0) AS "SumApplied",
    T0."InsTotal",
    T0."PaidToDate"
FROM ${db}.INV6 T0
INNER JOIN ${db}.OINV T1
    ON T0."DocEntry" = T1."DocEntry"
LEFT JOIN (
    SELECT
        R2."DocEntry",
        R2."InstId",
        SUM(R2."SumApplied") AS "SumApplied"
    FROM ${db}.RCT2 R2
    INNER JOIN ${db}.ORCT RCT
        ON RCT."DocEntry" = R2."DocNum"
    WHERE RCT."Canceled" = 'N'
    GROUP BY R2."DocEntry", R2."InstId"
) PAY
    ON PAY."DocEntry" = T0."DocEntry"
   AND PAY."InstId"   = T0."InstlmntID"
WHERE T0."DueDate" BETWEEN '${sd}' AND '${ed}'
  AND T1."CANCELED" = 'N'
  AND T1."CardCode" NOT IN ('Naqd','Bonus')
  AND NOT EXISTS (
      SELECT 1
      FROM ${db}.RIN1 CM1
      INNER JOIN ${db}.ORIN CM0 ON CM0."DocEntry" = CM1."DocEntry"
      WHERE CM1."BaseType"  = 13
        AND CM1."BaseEntry" = T1."DocEntry"
  )
  ${salesCondition}
`;
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
            return `WITH base_bp AS (
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
),

inv1_agg AS (
  SELECT
    I1."DocEntry",
    COUNT(*) AS "LineCount",
    COUNT(DISTINCT I1."ItemCode") AS "ItemCount",
    COALESCE(SUM(I1."Quantity"), 0) AS "TotalQty"
  FROM ${this.db}.INV1 I1
  GROUP BY I1."DocEntry"
)

SELECT
  T0."DocEntry",
  T0."DocNum",
  T0."CardCode",
  T1."DueDate",
  T1."InsTotal",
  T1."InstlmntID",
  T0."DocDate" AS "ContractDate",
  (SELECT SUM(A1."DocTotal")
   FROM ${this.db}.OINV A1
   WHERE A1."DocEntry" = T0."DocEntry" AND A1."CANCELED" = 'N') AS "Total",

  (SELECT SUM(A1."PaidToDate")
   FROM ${this.db}.OINV A1
   WHERE A1."DocEntry" = T0."DocEntry" AND A1."CANCELED" = 'N') AS "TotalPaid",

  COALESCE(SUM(T2."SumApplied"), 0) AS "SumApplied",
  MAX(T3."DocDate")  AS "DocDate",
  MAX(T3."Canceled") AS "Canceled",
  (SELECT STRING_AGG('{"ItemCode":"' || I1."ItemCode" || '","ItemName":"' || REPLACE(I1."Dscription", '"', '\"') || '"}', ',')
   FROM ${this.db}.INV1 I1
   WHERE I1."DocEntry" = T0."DocEntry") AS "ItemDetails",
  -- ✅ INV1 dan tovar statistikasi
  MAX(IAG."LineCount") AS "LineCount",
  MAX(IAG."ItemCount") AS "ItemCount",
  MAX(IAG."TotalQty")  AS "TotalQty"

FROM ${this.db}.INV6 T1
INNER JOIN ${this.db}.OINV T0
  ON T0."DocEntry" = T1."DocEntry"

LEFT JOIN inv1_agg IAG
  ON IAG."DocEntry" = T0."DocEntry"

LEFT JOIN ${this.db}.RCT2 T2
  ON T2."DocEntry" = T0."DocEntry"
 AND T2."InstId"    = T1."InstlmntID"

LEFT JOIN ${this.db}.ORCT T3
  ON T3."DocEntry" = T2."DocNum"

WHERE
  T0."CANCELED" = 'N'
  AND T0."CardCode" IN (SELECT "CardCode" FROM bp_codes)

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
  T0."DocDate",
  T1."InstlmntID",
  T1."DueDate",
  T1."InsTotal",
  T0."DocNum"

ORDER BY
  T0."DocEntry",
  T1."InstlmntID";`
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

    getItems({ search, filters = {}, limit = 50, offset = 0, whsCode, includeZeroOnHand = false }) {
        // ❗️OnHand > 0 ni endi flag bo‘yicha qo‘yamiz
        let whereClauses = ['1=1'];
        if (!includeZeroOnHand) {
            whereClauses.push(`T0."OnHand" > 0`);
        }

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

        if (filters.model) whereClauses.push(`T1."U_Model" = '${filters.model}'`);
        if (filters.deviceType) whereClauses.push(`T1."U_DeviceType" = '${filters.deviceType}'`);
        if (filters.memory) whereClauses.push(`T1."U_Memory" = '${filters.memory}'`);
        if (filters.simType) whereClauses.push(`T1."U_Sim_type" = '${filters.simType}'`);
        if (filters.condition) whereClauses.push(`T1."U_PROD_CONDITION" = '${filters.condition}'`);
        if (filters.color) whereClauses.push(`T1."U_Color" = '${filters.color}'`);

        if (filters.itemGroupCode) whereClauses.push(`T1."ItmsGrpCod" = '${filters.itemGroupCode}'`);

        const whereQuery = 'WHERE ' + whereClauses.join(' AND ') + imeiWhere;

        const imeiSelect = isIMEI ? `R."DistNumber" AS "IMEI",` : '';

        const distinctExpr = isIMEI
            ? `R."DistNumber"`
            : `T0."ItemCode" || ':' || T0."WhsCode"`;

        const baseFrom = `
    FROM ${this.db}."OITW" T0
      INNER JOIN ${this.db}."OITM" T1 ON T0."ItemCode" = T1."ItemCode"
      INNER JOIN ${this.db}."OWHS" T2 ON T0."WhsCode" = T2."WhsCode"
      INNER JOIN ${this.db}."OITB" G ON G."ItmsGrpCod" = T1."ItmsGrpCod"  -- ✅ item group
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
      MAX(T0."WhsCode")                     AS "WhsCode",
      SUM(CAST(T0."OnHand" AS INTEGER))     AS "OnHand",          -- jami qoldiq
      MAX(T1."ItemName")                    AS "ItemName",
      T1."ItmsGrpCod"                       AS "ItemGroupCode",
      MAX(G."ItmsGrpNam")                   AS "ItemGroupName",
      MAX(T1."U_Color")                     AS "U_Color",
      MAX(T1."U_Condition")                 AS "U_Condition",
      MAX(T1."U_Model")                     AS "U_Model",
      MAX(T1."U_DeviceType")                AS "U_DeviceType",
      MAX(T1."U_Memory")                    AS "U_Memory",
      MAX(T1."U_Sim_type")                  AS "U_Sim_type",
      MAX(T1."U_PROD_CONDITION")            AS "U_PROD_CONDITION",
      MAX(T2."WhsName")                     AS "WhsName",
      MAX(PR."Price")                       AS "SalePrice",
      ${isIMEI ? `MAX(R."CostTotal")` : `NULL`} AS "PurchasePrice"
    ${baseFrom}
    GROUP BY
      T0."ItemCode",
      T1."ItmsGrpCod"
      ${isIMEI ? `, R."DistNumber"` : ''}
    ORDER BY MAX(T1."U_Model") DESC
    LIMIT ${limit}
    OFFSET ${offset}
`;

        const countSql = `
    SELECT COUNT(DISTINCT ${isIMEI ? `R."DistNumber"` : `T0."ItemCode"`}) AS "total"
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

                    -- OCRD contact fields
                    NULLIF(TRIM(BP."Phone1"), '')    AS "Phone1",
                    NULLIF(TRIM(BP."Phone2"), '')    AS "Phone2",
                    NULLIF(TRIM(BP."Cellular"), '')  AS "Cellular",
                    NULLIF(TRIM(BP."U_jshshir"), '') AS "jshshir",

                    -- ✅ Notes -> address2 (siz Lead’da address2 ga qo‘ymoqchisiz)
                    NULLIF(TRIM(BP."Notes"), '')     AS "address2",

                    -- normalized phones (digits only)
                    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Cellular"), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') AS "cellular_norm",
                    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Phone1"),   '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') AS "phone1_norm",
                    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Phone2"),   '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') AS "phone2_norm",

                    -- person_key: prefer JSHSHIR, else normalized phone (Cellular -> Phone1 -> Phone2)
                    CASE
                        WHEN NULLIF(TRIM(BP."U_jshshir"), '') IS NOT NULL THEN TRIM(BP."U_jshshir")
                        WHEN NULLIF(TRIM(BP."Cellular"), '')  IS NOT NULL THEN
                            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Cellular"), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
                        WHEN NULLIF(TRIM(BP."Phone1"), '')    IS NOT NULL THEN
                            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Phone1"), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
                        WHEN NULLIF(TRIM(BP."Phone2"), '')    IS NOT NULL THEN
                            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(BP."Phone2"), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')
                        ELSE NULL
                        END AS "person_key"

                FROM ${this.db}."OCRD" BP
                WHERE BP."CardType" = 'C'
                  AND BP."U_blocked" = 'no'
            ),
                 bp_person AS (
                     SELECT *
                     FROM bp
                     WHERE "person_key" IS NOT NULL
                 ),

-- main profile per person_key (contacts aggregated)
                 person_main AS (
                     SELECT
                         "person_key",
                         MIN("CardCode") AS "CardCode",
                         MAX("CardName") AS "CardName",

                         MAX("jshshir")        AS "jshshir",
                         MAX("Cellular")       AS "Cellular",
                         MAX("cellular_norm")  AS "CellularNorm",
                         MAX("Phone1")         AS "Phone1",
                         MAX("Phone2")         AS "Phone2",

                         -- ✅ address2 (Notes)
                         MAX("address2")       AS "address2"
                     FROM bp_person
                     GROUP BY "person_key"
                 ),

/* ✅ 1) hamma invoice (ochiq+yopiq), keyin person bo‘yicha “ochiq bormi?” aniqlaymiz */
                 inv_all AS (
                     SELECT
                         I."DocEntry",
                         I."CardCode",
                         I."DocTotal",
                         I."PaidToDate",
                         I."DocStatus",
                         I."DocDate"
                     FROM ${this.db}."OINV" I
                     WHERE I."CANCELED" = 'N'
                       AND I."DocDate" >= DATE'2024-01-01'
                       -- CreditMemo bilan yopilgan invoice'larni chiqarib tashlash
                       AND NOT EXISTS (
                         SELECT 1
                         FROM ${this.db}."RIN1" CM1
                                  INNER JOIN ${this.db}."ORIN" CM0 ON CM0."DocEntry" = CM1."DocEntry"
                         WHERE CM1."BaseType"  = 13
                           AND CM1."BaseEntry" = I."DocEntry"
                     )
                 ),

/* ✅ 2) person_key bo‘yicha: bitta bo‘lsa ham ochiq invoice bo‘lsa -> hasOpenInvoice=1 */
                 person_invoice_state AS (
                     SELECT
                         P."person_key",
                         COUNT(DISTINCT I."DocEntry") AS "invoiceCount",
                         MAX(
                                 CASE
                                     WHEN I."DocStatus" = 'O' THEN 1
                                     WHEN I."PaidToDate" < I."DocTotal" - 5 THEN 1
                                     ELSE 0
                                     END
                         ) AS "hasOpenInvoice"
                     FROM bp_person P
                              INNER JOIN inv_all I ON I."CardCode" = P."CardCode"
                     GROUP BY P."person_key"
                 ),

/* 🔥 scoring ham inv_all bilan ishlaydi (ochiq invoice ham hisobga kiradi) */
                 inst_payments AS (
                     SELECT
                         P."person_key",
                         I."CardCode",
                         I."DocEntry",
                         S."InstlmntID",
                         S."DueDate",
                         S."InsTotal",
                         I."DocTotal"   AS "InvoiceTotal",
                         I."PaidToDate" AS "InvoicePaidToDate",

                         COALESCE(SUM(R2."SumApplied"), 0) AS "SumApplied",
                         MAX(R0."DocDate") AS "LastPayDate"
                     FROM bp_person P
                              INNER JOIN inv_all I ON I."CardCode" = P."CardCode"
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
                         COUNT(DISTINCT CASE WHEN X."InvoiceTotal" > X."InvoicePaidToDate" + 5 THEN X."DocEntry" ELSE NULL END) AS "openContracts",
                         SUM(DISTINCT X."InvoiceTotal")      AS "totalAmount",
                         SUM(DISTINCT X."InvoicePaidToDate") AS "totalPaid",
                         SUM(CASE WHEN X."DueDate" < X."Today" AND X."Unpaid" > 0 THEN X."Unpaid" ELSE 0 END) AS "overdueDebt",
                         MAX(X."DelayDays") AS "maxDelay",
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
                         CASE
                             WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) = 0 THEN 15
                             WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) <= 0.01 THEN 12
                             WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) <= 0.03 THEN 6
                             WHEN (CASE WHEN P."totalAmount" > 0 THEN P."overdueDebt" / P."totalAmount" ELSE 0 END) <= 0.05 THEN 2
                             ELSE 0
                             END AS "overScore",
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
                             END AS "penalty",
                        CASE
                            WHEN COALESCE(S."totalAmount", 0) <=  5000000 THEN 30
                            WHEN COALESCE(S."totalAmount", 0) <= 10000000 THEN 25
                            WHEN COALESCE(S."totalAmount", 0) <= 15000000 THEN 20
                            WHEN COALESCE(S."totalAmount", 0) <= 20000000 THEN 10
                            ELSE 0
                        END AS "sumPen"
                     FROM scoring S
                 ),

                 limits AS (
                     SELECT
                         F.*,
                         FLOOR(F."baseFinal" - F."penalty" - F."sumPen") AS "internalScore",
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
                PM."CardCode"     AS "CardCode",
                PM."CardName"     AS "CardName",
                PM."Phone1"       AS "Phone1",
                PM."Phone2"       AS "Phone2",
                PM."Cellular"     AS "Cellular",
                PM."CellularNorm" AS "CellularNorm",
                PM."jshshir"      AS "jshshir",
                PM."address2"     AS "address2",

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
                     JOIN person_invoice_state PS ON PS."person_key" = L."person_key"

            WHERE
              -- ✅ faqat shunday odamlar: hamma invoice'lari yopilgan (bitta ochiq bo‘lsa ham drop)
                PS."invoiceCount" > 0
              AND PS."hasOpenInvoice" = 0

              AND (CASE
                       WHEN LOWER(L."trustLabel") = 'xavfli' THEN LEAST(L."limitRaw", 5000000)
                       ELSE L."limitRaw"
                END) = 30000000

            ORDER BY "limit" DESC
        `;
    }

    getMehrliQongiroqCandidates() {
        return `
        WITH new_sales AS (
            SELECT 
                T0."CardCode", 
                MAX(T0."CardName") AS "CardName",
                MAX(BP."Phone1") AS "Phone1",
                MAX(BP."Cellular") AS "Cellular",
                'NEW_SALE' AS "EventType",
                STRING_AGG(T1."Dscription", ', ') AS "ItemNames",
                SUM(T0."DocTotal") AS "Amount",
                0 AS "InstlmntID",
                0 AS "TotalInstlmnt",
                T0."DocEntry" AS "DocEntry"
            FROM ${this.db}."OINV" T0
            JOIN ${this.db}."INV1" T1 ON T0."DocEntry" = T1."DocEntry"
            JOIN ${this.db}."OCRD" BP ON T0."CardCode" = BP."CardCode"
            WHERE T0."DocDate" = ADD_DAYS(CURRENT_DATE, -1)
              AND T0."CANCELED" = 'N'
            GROUP BY T0."CardCode", T0."DocEntry"
        ),
        on_time_payments AS (
            SELECT 
                T0."CardCode", 
                MAX(T0."CardName") AS "CardName",
                MAX(BP."Phone1") AS "Phone1",
                MAX(BP."Cellular") AS "Cellular",
                'PAYMENT' AS "EventType",
                STRING_AGG(T4."Dscription", ', ') AS "ItemNames",
                SUM(T1."SumApplied") AS "Amount",
                MAX(T3."InstlmntID") AS "InstlmntID",
                (SELECT COUNT(*) FROM ${this.db}."INV6" IX WHERE IX."DocEntry" = T2."DocEntry") AS "TotalInstlmnt",
                T2."DocEntry" AS "DocEntry"
            FROM ${this.db}."ORCT" T0
            JOIN ${this.db}."RCT2" T1 ON T0."DocEntry" = T1."DocNum"
            JOIN ${this.db}."OINV" T2 ON T1."DocEntry" = T2."DocEntry" AND T1."InvType" = 13
            JOIN ${this.db}."INV6" T3 ON T2."DocEntry" = T3."DocEntry" AND T1."InstId" = T3."InstlmntID"
            JOIN ${this.db}."INV1" T4 ON T2."DocEntry" = T4."DocEntry"
            JOIN ${this.db}."OCRD" BP ON T0."CardCode" = BP."CardCode"
            WHERE T0."DocDate" = ADD_DAYS(CURRENT_DATE, -1)
              AND T0."Canceled" = 'N'
              AND DAYS_BETWEEN(T3."DueDate", T0."DocDate") <= 2
            GROUP BY T0."CardCode", T2."DocEntry"
        ),
        combined AS (
            SELECT * FROM new_sales
            UNION ALL
            SELECT * FROM on_time_payments
        )
        SELECT C.* FROM combined C
        WHERE C."Phone1" IS NOT NULL OR C."Cellular" IS NOT NULL
        LIMIT 100
    `;
    }

    escapeLike = (v = '') => String(v).replace(/[%_\\]/g, (m) => '\\' + m);

    sqlStr = (v) => String(v ?? '').replace(/'/g, "''");

    sqlNum = (v, def = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : def;
    };

    getPurchases({ search, status, limit = 20, offset = 0, dateFrom, dateTo }) {
        const normalizedLimit = Math.max(1, Math.min(this.sqlNum(limit, 20), 200));
        const normalizedOffset = Math.max(0, this.sqlNum(offset, 0));

        const sRaw = search ? search.trim() : '';
        const s = sRaw ? this.escapeLike(sRaw.toLowerCase()) : '';
        const searchLike = s ? `%${s}%` : '';

        const normalizedStatus =
            status === 'approve' || status === 'pending' || status === 'rejected'
                ? status
                : null;

        // DATE CONDITIONS
        const dateCondition_OPCH = `
    ${dateFrom ? `AND H."DocDate" >= '${this.sqlStr(dateFrom)}'` : ''}
    ${dateTo ? `AND H."DocDate" <= '${this.sqlStr(dateTo)}'` : ''}
  `;

        const dateCondition_ODRF = `
    ${dateFrom ? `AND D."DocDate" >= '${this.sqlStr(dateFrom)}'` : ''}
    ${dateTo ? `AND D."DocDate" <= '${this.sqlStr(dateTo)}'` : ''}
  `;

        // STATUS CONDITIONS
        const statusCond_OPCH =
            normalizedStatus === 'approve'
                ? ''
                : normalizedStatus
                    ? 'AND 1=0'
                    : '';

        const statusCond_ODRF =
            !normalizedStatus
                ? ''
                : normalizedStatus === 'pending'
                    ? `AND D."CANCELED" = 'N'`
                    : normalizedStatus === 'rejected'
                        ? `AND D."CANCELED" = 'Y'`
                        : `AND 1=0`;

        // hide converted drafts except rejected list
        const hideConvertedDraftCond =
            normalizedStatus === 'rejected'
                ? ''
                : `
        AND NOT EXISTS (
          SELECT 1
          FROM ${this.db}."OPCH" X
          WHERE X."CANCELED" = 'N'
            AND X."draftKey" = D."DocEntry"
        )
      `;

        // SEARCH CONDITIONS (include IMEI)
        const searchCondition_OPCH = s
            ? `
      AND (
        LOWER(CAST(H."DocNum" AS NVARCHAR(50))) LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        OR LOWER(IFNULL(H."CardCode", ''))      LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        OR LOWER(IFNULL(H."CardName", ''))      LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        OR LOWER(IFNULL(H."Comments", ''))      LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
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
            AND LOWER(IFNULL(S."IntrSerial", '')) LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        )
      )
    `
            : '';

        const searchCondition_ODRF = s
            ? `
      AND (
        LOWER(CAST(D."DocNum" AS NVARCHAR(50))) LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        OR LOWER(IFNULL(D."CardCode", ''))      LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        OR LOWER(IFNULL(D."CardName", ''))      LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        OR LOWER(IFNULL(D."Comments", ''))      LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM ${this.db}."DRF1" L
          WHERE L."DocEntry" = D."DocEntry"
            AND LOWER(IFNULL(L."U_series", '')) LIKE '${this.sqlStr(searchLike)}' ESCAPE '\\'
        )
      )
    `
            : '';

        const baseUnion = `
    SELECT
      'doc' AS "source",
      'approve' AS "status",
      H."DocEntry" AS "docEntry",
      H."DocNum" AS "docNum",
      H."DocDate" AS "docDate",
      H."DocDueDate" AS "docDueDate",
      H."CardCode" AS "cardCode",
      H."CardName" AS "cardName",
      H."DocCur" AS "docCur",
      H."DocRate" AS "docRate",
      H."DocTotal" AS "docTotal",
      H."Comments" AS "comments",
      (
          SELECT STRING_AGG(X."pair", '||')
          FROM (
                   SELECT DISTINCT
                       CAST(M."ItmsGrpCod" AS NVARCHAR(20)) || '::' || B."ItmsGrpNam" AS "pair"
                   FROM ${this.db}."PCH1" L
                            JOIN ${this.db}."OITM" M ON M."ItemCode" = L."ItemCode"
                            JOIN ${this.db}."OITB" B ON B."ItmsGrpCod" = M."ItmsGrpCod"
                   WHERE L."DocEntry" = H."DocEntry"
               ) X
      ) AS "groupPairs"
    FROM ${this.db}."OPCH" H
    WHERE
      H."CANCELED" = 'N'
      ${dateCondition_OPCH}
      ${statusCond_OPCH}
      ${searchCondition_OPCH}

    UNION ALL

    SELECT
      'draft' AS "source",
      CASE WHEN D."CANCELED"='Y' THEN 'rejected' ELSE 'pending' END AS "status",
      D."DocEntry" AS "docEntry",
      D."DocNum" AS "docNum",
      D."DocDate" AS "docDate",
      D."DocDueDate" AS "docDueDate",
      D."CardCode" AS "cardCode",
      D."CardName" AS "cardName",
      D."DocCur" AS "docCur",
      D."DocRate" AS "docRate",
      D."DocTotal" AS "docTotal",
      D."Comments" AS "comments",
      (
          SELECT STRING_AGG(X."pair", '||')
          FROM (
                   SELECT DISTINCT
                       CAST(M."ItmsGrpCod" AS NVARCHAR(20)) || '::' || B."ItmsGrpNam" AS "pair"
                   FROM ${this.db}."DRF1" L
                            JOIN ${this.db}."OITM" M ON M."ItemCode" = L."ItemCode"
                            JOIN ${this.db}."OITB" B ON B."ItmsGrpCod" = M."ItmsGrpCod"
                   WHERE L."DocEntry" = D."DocEntry"
               ) X
      ) AS "groupPairs"
    FROM ${this.db}."ODRF" D
    WHERE
      D."ObjType" = 18
      ${dateCondition_ODRF}
      ${statusCond_ODRF}
      ${hideConvertedDraftCond}
      ${searchCondition_ODRF}
  `;

        const countSql = `
    SELECT COUNT(*) AS "total"
    FROM (${baseUnion}) Z
  `;

        const dataSql = `
    SELECT
      Q.*,
      COUNT(*) OVER() AS "total"
    FROM (${baseUnion}) Q
    ORDER BY Q."docDate" DESC, Q."docEntry" DESC
    LIMIT ${normalizedLimit} OFFSET ${normalizedOffset}
  `;

        return { dataSql, countSql };
    }

    getPurchaseDetail({ source, docEntry }) {
        const isDoc = String(source) === 'doc';
        const docEntryNum = this.sqlNum(docEntry, 0);
        if (!docEntryNum) throw new Error('docEntry must be positive number');

        const headerTable = isDoc ? `${this.db}."OPCH"` : `${this.db}."ODRF"`;
        const linesTable  = isDoc ? `${this.db}."PCH1"` : `${this.db}."DRF1"`;

        const headerSql = `
    SELECT
      '${isDoc ? 'doc' : 'draft'}' AS "source",
      ${isDoc ? `'approve'` : `CASE WHEN H."CANCELED"='Y' THEN 'rejected' ELSE 'pending' END`} AS "status",
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
      ${isDoc ? `H."CANCELED"='N'` : `H."ObjType"=18`}
      AND H."DocEntry" = ${docEntryNum}
  `;

        const dataSql = isDoc ? `
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
      L."U_condition" AS "prodCondition"
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
      L."DocEntry" = ${docEntryNum}
    ORDER BY
      L."LineNum" ASC,
      S."IntrSerial" ASC
  ` : `
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
      L."U_condition" AS "prodCondition"
    FROM ${linesTable} L
    JOIN ${this.db}."OITM" I
      ON I."ItemCode" = L."ItemCode"
    WHERE
      L."DocEntry" = ${docEntryNum}
    ORDER BY
      L."LineNum" ASC
  `;

        return { headerSql, dataSql };
    }
}

module.exports = new DataRepositories(db);