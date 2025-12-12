const jwt = require('jsonwebtoken');

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

        try {
            jwt.verify(token, JWT_SECRET);
        } catch (err) {
            context.res = {
                status: 401,
                body: { message: "Invalid token" }
            };
            return;
        }

        context.res = {
            status: 200,
            body: { 
                message: "Logout successful. Please remove the token from client storage." 
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