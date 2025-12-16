const verifyToken = require('../src/verifyToken');

module.exports = async function (context, req) {
    const user = await verifyToken(req); // ✅ AWAIT added

    if (!user) {
        context.res = {
            status: 401,
            body: { message: "Unauthorized. Invalid or missing token." }
        };
        return;
    }

    context.res = {
        status: 200,
        body: {
            message: "You are logged in! This is a protected test API.",
            user: user
        }
    };
};
