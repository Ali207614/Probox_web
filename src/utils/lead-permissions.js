const {validateFields} = require("./validate-types");
const LeadModel = require("../models/lead-model");
const moment = require("moment-timezone");
const DataRepositories = require("../repositories/dataRepositories");

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
        'passportId',
        'region',
        'district',
        'address',
        'comment',
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
        'comment',
        'clientPhone2'
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
        'comment',
        'clientPhone2'
    ],
    Seller: [
        'meetingConfirmed',
        'meetingConfirmedDate',
        'purchase',
        'purchaseDate',
        'saleType',
        'jshshir',
        'passportId',
        'branch2',
        'seller',
        'source2',
        'region',
        'district',
        'address',
        'comment',
        'clientPhone2'
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
        'acceptReason',
        "acceptedReason",
        'comment',
        'status',
        'clientPhone2'
    ],
};

// === Qo‘shimcha rollar ===
permissions.OperatorM = [
    ...permissions.Operator1,
    ...permissions.Operator2,
    'operator',
    'operator2',
    'status',
    'isBlocked',

];

permissions.CEO = [
    ...permissions.Operator1,
    ...permissions.Operator2,
    ...permissions.Seller,
    ...permissions.Scoring,
    'isBlocked',
    'status',
];

module.exports = permissions;


