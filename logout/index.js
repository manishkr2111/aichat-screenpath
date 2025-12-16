const jwt = require('jsonwebtoken');
const { getContainer } = require('../db');

module.exports = async function (context, req) {
    try {
        const JWT_SECRET = process.env.JWT_SECRET;
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            context.res = {
                status: 401,
                body: { message: "No token provided" }
            };
            return;
        }

        const token = authHeader.substring(7);

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch {
            context.res = {
                status: 401,
                body: { message: "Invalid or expired token" }
            };
            return;
        }

        const usersContainer = getContainer(process.env.COSMOS_USER_CONTAINER);

        // ✅ Correct read using partition key = email
        const { resource: user } = await usersContainer
            .item(decoded.id, decoded.email)
            .read();

        if (!user) {
            context.res = {
                status: 401,
                body: { message: "User not found" }
            };
            return;
        }

        // ✅ Invalidate token
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await usersContainer.items.upsert(user);

        context.res = {
            status: 200,
            body: {
                message: "Logout successful. Token invalidated."
            }
        };

    } catch (err) {
        context.log('Logout error:', err);
        context.res = {
            status: 500,
            body: {
                message: "Internal server error",
                error: err.message
            }
        };
    }
};
