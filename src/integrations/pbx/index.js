'use strict';

require('dotenv').config();

const { createOnlinePbx } = require('../../controllers/pbx.client');

const pbxClient = createOnlinePbx({
    domain: process.env.PBX_DOMAIN,
    authKey: process.env.PBX_AUTH_KEY,
    apiHost: process.env.PBX_API_HOST || 'https://api2.onlinepbx.ru',
});

const PBX_TRUNK_NAME = process.env.PBX_TRUNK_NAME || 'f6813980348e52891f64fa3ce451de69';

module.exports = {
    pbxClient,
    PBX_TRUNK_NAME,
};