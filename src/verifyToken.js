const jwt = require('jsonwebtoken');
const { getContainer } = require('../db');

async function verifyToken(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];
    if (!token) return null;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const usersContainer = getContainer(process.env.COSMOS_USER_CONTAINER);

        // Fetch user from Cosmos DB using email as partition key
        const { resource: user } = await usersContainer
            .item(decoded.id, decoded.email)
            .read();

        if (!user) return null;

        // Ensure tokenVersion exists
        if (!user.tokenVersion) user.tokenVersion = 0;

        // Validate tokenVersion
        if (decoded.tokenVersion !== user.tokenVersion) return null;

        // Return user object
        return {
            id: user.id,
            name: user.name,
            email: user.email,
            tokenVersion: user.tokenVersion
        };
    } catch (err) {
        console.log("Token verification error:", err.message);
        return null;
    }
}

module.exports = verifyToken;
