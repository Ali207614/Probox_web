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
        'region',
        'district',
        'address',
        'comment'
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
        'region',
        'district',
        'address',
        'comment'
    ],
    Seller: [
        'meetingConfirmed',
        'meetingConfirmedDate',
        'purchase',
        'purchaseDate',
        'saleType',
        'passportId',
        'jshshir2',
        'branch2',
        'seller',
        'source2',
        'region',
        'district',
        'address',
        'comment'
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
        'comment'
    ],
};

// === Qo‘shimcha rollar ===
permissions.OperatorM = [
    ...permissions.Operator1,
    ...permissions.Operator2,
    'operator',
    'operator2'
];

permissions.CEO = [
    ...permissions.Operator1,
    ...permissions.Operator2,
    ...permissions.Seller,
    ...permissions.Scoring,
];

module.exports = permissions;
