const { Schema, model } = require('mongoose');


const LeadSchema = new Schema(
    {
        n: { type: String, description: 'Tartib raqami' },
        uniqueId: {
            type: String,
            default: undefined, // null emas
            description: 'Unique ID',
        },
        pbx: {
            last_uuid: String,
            last_event: String,
            last_direction: String,   // inbound/outbound
            last_date: Date,
            last_operator_ext: String,
            last_download_url: String,

            prev_status: { type: String, default: null },
        },

        limit: { type: Number, description: 'Ajratilgan limit yoki kredit miqdori' },
        paymentScore: { type: String, description: 'Payment Score' },
        totalContracts: { type: String, description: 'Payment Score' },
        openContracts: { type: String, description: 'Payment Score' },
        totalAmount: { type: String, description: 'Payment Score' },
        totalPaid: { type: String, description: 'Payment Score' },
        overdueDebt: { type: String, description: 'Payment Score' },
        maxDelay: { type: String, description: 'Payment Score' },
        avgPaymentDelay: { type: String, description: 'Payment Score' },
        clientName: { type: String, trim: true, description: 'Mijozning to‘liq ismi (Umumiy ozgarmaydi)' },
        clientPhone: { type: String, trim: true, description: 'Mijozning telefon raqami (Umumiy ozgarmaydi)' },
        clientPhone2: { type: String, trim: true, description: 'Mijozning telefon raqami (Umumiy ozgarmaydi)' },
        cardCode: { type: String, trim: true, description: 'CardCode' },
        cardName: { type: String, trim: true, description: 'CardName' },
        source: { type: String, description: 'Manba (reklama, ijtimoiy tarmoq, va hokazo) (Umumiy ozgarmaydi)' },
        leadTime:{ type: String,description: 'CardCode'},
        time: { type: Date, description: 'Yozilgan vaqt (Umumiy ozgarmaydi)' },
        recallDate: { type: Date, description: 'Kelishilgan vaqt' },
        newTime: { type: Date, index: true, description: 'Yozilgan vaqt (Umumiy ozgarmaydi)' },
        operator: { type: String, description: 'Qo‘ng‘iroq qilgan operator (Operator1 )' },
        called: { type: Boolean, description: 'Qo‘ng‘iroq qilindimi? (Operator1 true/false)' },
        callTime: { type: Date, description: 'Qo‘ng‘iroq vaqti(Operator1 ozgarmaydi faqat view)' },
        answered: { type: Boolean, description: 'Javob berildimi? (Operator1 true/false ozgaradi)' },
        callCount: { type: Number, default: 0, description: 'Qo‘ng‘iroqlar soni (Operator1 ozgaradi )' },
        noAnswerCount: { type: Number, default: 0, description: 'Qo‘ng‘iroqlar soni (Operator1 ozgaradi )' },
        interested: { type: Boolean, description: 'Qiziqish bildirildimi? (Operator1 true/false ozgaradi)' },
        rejectionReason: { type: String, description: 'Rad etish sababi (Operator1  ozgaradi)' },
        passportVisit: { type: String, description: 'Pasport yoki tashrif identifikatori ( Operator1 Passport/Tashrif)' },
        jshshir: { type: String, description: 'JSHSHIR raqami (Operator1 ozgaradi)' },
        idX: { type: String, description: 'Tashqi tizimdagi identifikator (Operator1 ozgaradi)' },
        operator2: { type: String, description: 'Ikkinchi operator ismi' },
        called2: { type: Boolean, description: 'Ikkinchi Operator2 qilindimi? (Operator2 true/false ozgaradi)' },
        answered2: { type: Boolean, description: 'Ikkinchi operator javob oldimi? (Operator2 true/false ozgaradi)' },
        callCount2: { type: Number, description: 'Ikkinchi operator qo‘ng‘iroqlar soni (Operator2 ozgaradi)' },
        meetingDate: { type: Date, description: 'Uchrashuv sanasi (Operator2 ozgaradi)' },
        rejectionReason2: { type: String, description: 'Ikkinchi rad sababi (Operator2 ozgaradi)' },
        paymentInterest: { type: String, description: 'Qanday to‘lov turiga qiziqish bildirildi (Operator2 ozgaradi trade/nasiya/naqd)' },
        branch: { type: String, description: 'Filial nomi (Operator2 ozgaradi)' },
        meetingHappened: { type: Boolean, description: 'Uchrashuv bo‘ldimi? (Operator2 true/false ozgaradi)' },
        percentage: { type: Number, description: 'Foiz stavkasi' },
        meetingConfirmed: { type: Boolean, description: 'Uchrashuv tasdiqlandi (Sotuvchi ozgaradi)' },
        isBlocked: { type: Boolean, description: 'Blok bolganlari' },
        meetingConfirmedDate: { type: Date, description: 'Tasdiqlangan sana (Sotuvchi  ozgaradi)' },
        consultant: { type: String, description: 'Maslahatchi (konsultant) ismi (Sotuvchi tanladi )' },
        purchase: { type: Boolean, description: 'Xarid amalga oshdimi? (Sotuvchi ozgaradi)' },
        purchaseDate: { type: Date, description: 'Xarid sanasi' },
        saleType: { type: String, description: 'Savdo turi (naqd, kredit, muddatli...) (Sotuvchi ozgaradi)' },
        passportId: { type: String, description: 'Pasport ID (Sotuvchi ozgaradi)' },
        jshshir2: { type: String, description: 'Qo‘shimcha JSHSHIR raqami (Sotuvchi ozgaradi)' },
        clientFullName: { type: String, description: 'Client F.I.O (Scoring)' },
        source2: {type: String, description:"Manba (reklama, ijtimoiy tarmoq, va hokazo) (Scoring ozgariradi)"},
        seller: { type: String, description: 'Seller (Scoring ozgariradi)' },

        region: { type: String, description: 'Viloyat (Scoring ozgariradi)' },
        district: { type: String, description: 'Tuman (Scoring ozgariradi)' },
        neighborhood: { type: String, trim: true, description: 'MFY (Mahalla fuqarolar yigini)' },
        street: { type: String, trim: true, description: 'Ko‘cha' },
        house: { type: String, trim: true, description: 'Uy raqami' },

        address: { type: String, description: 'Yashash manzili (Scoring ozgariradi)' },
        address2: { type: String, description: 'Yashash manzili (Scoring ozgariradi)' },
        branch2: { type: String, description: 'Filial nomi (Seller ozgaradi)' },
        birthDate: { type: Date, description: 'Tug‘ilgan sana (Scoring ozgariradi)' },
        applicationDate: { type: Date, description: 'Ariza topshirilgan sana (Scoring ozgariradi)' },
        scoring: { type: String, description: 'Scoring (Scoring ozgariradi)' },
        age: { type: Number, description: 'Mijoz yoshi (Scoring ozgariradi)' },
        score: { type: Number, description: 'Ball yoki reyting (Scoring ozgariradi)' },
        katm: { type: String, description: 'KATM nomi (Scoring ozgariradi)' },
        katmPayment: { type: Number, description: 'KATM to‘lov miqdori (Scoring ozgariradi)' },
        paymentHistory: { type: String, description: 'To‘lovlar tarixi (Scoring ozgariradi)' },
        acceptedReason:{type: String,description:"Ruxsat berilgan sababi (Scoring ozgariradi)"},
        comment:{type: String,description:"Ruxsat berilgan sababi (Scoring ozgariradi)"},
        mib: { type: Number, description: 'MIB mavjudmi? (Scoring ozgariradi)' },
        mibIrresponsible: { type: Number, description: 'MIB mas’uliyatsiz deb belgilanganmi? (Scoring ozgariradi)' },
        aliment: { type: Number, description: 'Aliment to‘laydimi? (Scoring ozgariradi)' },
        officialSalary: { type: Number, description: 'Rasmiy oylik daromad (Scoring ozgariradi)' },
        finalLimit: { type: Number, description: 'Yakuniy tasdiqlangan limit (Scoring ozgariradi)' },
        finalPercentage: { type: Number, description: 'Yakuniy foiz stavkasi (Scoring ozgariradi)' },
        limitDate: {
            type: Date,
            default: null,
        },
        seen: {
            type: Boolean,
            default: null,
        },
        talkedFlag: { type: Boolean, default: false, index: true },
        talkedAt: { type: Date, default: null, index: true },

        // Lead status mapping (EN -> UZ)
// Active          -> Yange lead
// Blocked         -> Bloklangan
// Purchased       -> Xarid qildi
// Returned        -> Qaytarildi
// Missed          -> O'tkazib yuborildi
// Ignored         -> E'tiborsiz
// NoAnswer        -> Javob bermadi
// FollowUp        -> Qayta a'loqa
// Considering     -> O'ylab ko'radi
// WillVisitStore  -> Do'konga boradi
// WillSendPassport-> Passport yuboradi
// Scoring         -> Skoring
// ScoringResult   -> Skoring natija
// VisitedStore    -> Do'konga keldi
// NoPurchase      -> Xarid bo'lmadi
// Closed      -> Sifatsiz

        status: {
            type: String,
            description: "Status",
            enum: [
                'Active',
                'Blocked',
                'Purchased',
                'Returned',
                'Missed',
                'Ignored',
                'NoAnswer',
                'FollowUp',
                'Considering',
                'WillVisitStore',
                'WillSendPassport',
                'Scoring',
                'ScoringResult',
                'VisitedStore',
                'NoPurchase',
                'Closed',
            ],
            default: 'Active',
        },

        invoiceCreated: {
            type: Boolean,
            default: false,
            description: "Invoice SAP B1 orqali muvaffaqiyatli yaratildimi"
        },
        invoiceDocEntry: {
            type: String,
            default: null,
            description: "SAP Invoice DocEntry"
        },
        invoiceDocNum: {
            type: String,
            default: null,
            description: "SAP Invoice DocNum"
        },
        invoiceCreatedAt: {
            type: Date,
            default: null,
            description: "Invoice yaratilgan sana"
        },
        statusChangedAt: { type: Date, default: null, index: true },
    },
        { timestamps: true }
);

LeadSchema.index(
    { uniqueId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            uniqueId: { $type: 'string' }, // faqat string bo'lsa unique tekshiradi
        },
    }
);


module.exports = model('Lead', LeadSchema);







