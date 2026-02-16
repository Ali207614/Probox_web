const {validateFields} = require("./validate-types");
const LeadModel = require("../models/lead-model");
const moment = require("moment-timezone");
const DataRepositories = require("../repositories/dataRepositories");

const permissions = {
    Operator1: [
        'clientName',
        'clientFullName',
        'callTime',
        // 'called',
        // 'answered',
        // 'callCount',
        // 'interested',
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
        'clientPhone2',
        'clientPhone',
        'neighborhood',
        'street',
        'house',
        'address2',
        'seen',
        'status',
        'recallDate'
    ],
    Operator2: [

    ],
    Seller: [
        'meetingConfirmed',
        'meetingConfirmedDate',
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
        'clientPhone2',
        'rejectionReason2',
        'rejectionReason',
        'clientPhone',
        'neighborhood',
        'street',
        'house',
        'address2',
        'status',
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
        'clientPhone2',
        'clientPhone',
        'neighborhood',
        'street',
        'house',
        'address2'
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
    'seen'

];

permissions.CEO = [
    ...permissions.Operator1,
    ...permissions.Operator2,
    ...permissions.Seller,
    ...permissions.Scoring,
    'isBlocked',
    'status',
    'purchase',
    'purchaseDate',
];

module.exports = permissions;


