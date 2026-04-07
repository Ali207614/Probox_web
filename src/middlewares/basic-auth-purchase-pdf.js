'use strict';

function purchasePdfBasicAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';

        if (!authHeader.startsWith('Basic ')) {
            return res.status(401).json({
                message: 'Unauthorized',
                location: 'purchase_pdf_basic_auth_missing',
            });
        }

        const base64 = authHeader.split(' ')[1];
        const decoded = Buffer.from(base64, 'base64').toString('utf8'); // username:password

        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex === -1) {
            return res.status(401).json({
                message: 'Unauthorized',
                location: 'purchase_pdf_basic_auth_invalid_format',
            });
        }

        const username = decoded.slice(0, separatorIndex);
        const password = decoded.slice(separatorIndex + 1);

        const expectedUser = process.env.PURCHASE_PDF_API_USER;
        const expectedPass = process.env.PURCHASE_PDF_API_PASS;

        if (!expectedUser || !expectedPass) {
            console.error('PURCHASE_PDF_API_USER / PURCHASE_PDF_API_PASS is not configured');
            return res.status(500).json({
                message: 'Server auth config error',
                location: 'purchase_pdf_basic_auth_server_config',
            });
        }

        if (username !== expectedUser || password !== expectedPass) {
            return res.status(401).json({
                message: 'Unauthorized',
                location: 'purchase_pdf_basic_auth_invalid_credentials',
            });
        }

        req.basicAuthUser = {
            username,
            type: 'purchase_pdf',
        };

        return next();
    } catch (error) {
        console.error('purchasePdfBasicAuth error:', error);
        return res.status(500).json({
            message: 'Internal server error',
            location: 'purchase_pdf_basic_auth_catch',
        });
    }
}

module.exports = { purchasePdfBasicAuth };
