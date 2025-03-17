const jwt = require('jsonwebtoken');

class TokenService {
    generateJwt(arg) {
        return jwt.sign(
            arg,
            process.env.secret_key,
            { expiresIn: '24h' }
        )
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
