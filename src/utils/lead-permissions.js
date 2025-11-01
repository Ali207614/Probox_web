// permissions.js
const permissions = {
    Operator1: [
        'called',
        'callTime',
        'answered',
        'callCount',
        'interested',
        'rejectionReason',
        'passportVisit',
        'jshshir',
        'idX',
    ],
    Operator2: [
        'called2',
        'answered2',
        'callCount2',
        'meetingDate',
        'rejectionReason2',
        'paymentInterest',
        'branch',
        'meetingHappened',
    ],
    Seller: [
        'meetingConfirmed',
        'meetingConfirmedDate',
        'consultant',
        'purchase',
        'purchaseDate',
        'saleType',
        'passportId',
        'jshshir2',
        'branch2',
        'seller',
        'source2',
    ],
    Scoring: [
        'clientFullName',
        'region',
        'district',
        'address',
        'birthDate',
        'applicationDate',
        'age',
        'score',
        'katm',
        'katmPayment',
        'paymentHistory',
        'mib',
        'mibIrresponsible',
        'aliment',
        'officialSalary',
        'finalLimit',
        'finalPercentage',
        'scoring',
        'acceptReason',
    ],
};

// === Qo‘shimcha rollar ===
permissions.OperatorM = [
    ...permissions.Operator1,
    ...permissions.Operator2,
];

permissions.CEO = [
    ...permissions.Operator1,
    ...permissions.Operator2,
    ...permissions.Seller,
    ...permissions.Scoring,
];

module.exports = permissions;
