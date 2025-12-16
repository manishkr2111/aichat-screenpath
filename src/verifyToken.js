const jwt = require('jsonwebtoken');
const { getContainer } = require('../db');

async function verifyToken(req) {
    const authHeader =
        req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];
    if (!token) return null;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const usersContainer = getContainer(process.env.COSMOS_USER_CONTAINER);

        // ✅ CORRECT: partition key = email
        const { resource: user } = await usersContainer
            .item(decoded.id, decoded.email)
            .read();

        if (!user || decoded.tokenVersion !== user.tokenVersion) {
            return null;
        }

        return decoded;
    } catch {
        return null;
    }
}

module.exports = verifyToken;
