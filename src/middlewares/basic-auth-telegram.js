'use strict';

function telegramBotBasicAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';

        if (!authHeader.startsWith('Basic ')) {
            return res.status(401).json({
                message: 'Unauthorized',
                location: 'telegram_bot_basic_auth_missing',
            });
        }

        const base64 = authHeader.split(' ')[1];
        const decoded = Buffer.from(base64, 'base64').toString('utf8'); // username:password

        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex === -1) {
            return res.status(401).json({
                message: 'Unauthorized',
                location: 'telegram_bot_basic_auth_invalid_format',
            });
        }

        const username = decoded.slice(0, separatorIndex);
        const password = decoded.slice(separatorIndex + 1);

        // ✅ .env dan oling
        const expectedUser = process.env.TELEGRAM_BOT_API_USER;
        const expectedPass = process.env.TELEGRAM_BOT_API_PASS;

        if (!expectedUser || !expectedPass) {
            console.error('TELEGRAM_BOT_API_USER / TELEGRAM_BOT_API_PASS is not configured');
            return res.status(500).json({
                message: 'Server auth config error',
                location: 'telegram_bot_basic_auth_server_config',
            });
        }

        if (username !== expectedUser || password !== expectedPass) {
            return res.status(401).json({
                message: 'Unauthorized',
                location: 'telegram_bot_basic_auth_invalid_credentials',
            });
        }

        // xohlasangiz req ga service user yozib qo‘ying
        req.basicAuthUser = {
            username,
            type: 'telegram_bot',
        };

        return next();
    } catch (error) {
        console.error('telegramBotBasicAuth error:', error);
        return res.status(500).json({
            message: 'Internal server error',
            location: 'telegram_bot_basic_auth_catch',
        });
    }
}

module.exports = { telegramBotBasicAuth };