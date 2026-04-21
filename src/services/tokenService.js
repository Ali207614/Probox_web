const jwt = require('jsonwebtoken');
const crypto = require('crypto');

class TokenService {
    generateJwt(payload) {
        const jti = crypto.randomBytes(16).toString('hex');
        const token = jwt.sign(
            payload,
            process.env.secret_key,
            { expiresIn: '24h', jwtid: jti }
        );
        return { token, jti };
    }

    validateAccessToken(token) {
        try {
            const userData = jwt.verify(token, process.env.secret_key);
            return userData;
        } catch (e) {
            return null;
        }
    }

}

module.exports = new TokenService();
