'use strict';

require('dotenv').config();

const { createOnlinePbx } = require('../../controllers/pbx.client');

const pbxClient = createOnlinePbx({
    domain: process.env.PBX_DOMAIN,
    authKey: process.env.PBX_AUTH_KEY,
    apiHost: process.env.PBX_API_HOST || 'https://api2.onlinepbx.ru',
});

const TRUNK_NAMES = (process.env.PBX_TRUNK_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
    pbxClient,
    TRUNK_NAMES,
};