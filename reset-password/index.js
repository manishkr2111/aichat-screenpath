const { getContainer } = require('../db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

module.exports = async function (context, req) {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            context.res = { 
                status: 400, 
                body: { message: "Token and new password are required" } 
            };
            return;
        }

        const usersContainer = getContainer(process.env.COSMOS_USER_CONTAINER);

        // Hash the token to match stored hashed token
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        // Find the user by resetToken and check expiry
        const querySpec = {
            query: "SELECT * FROM c WHERE c.resetToken = @token",
            parameters: [{ name: "@token", value: hashedToken }]
        };

        const { resources: users } = await usersContainer.items.query(querySpec).fetchAll();

        if (users.length === 0 || users[0].resetTokenExpiry < Date.now()) {
            context.res = { status: 400, body: { message: "Invalid or expired token" } };
            return;
        }

        const user = users[0];

        // Hash the new password before storing
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        user.resetToken = null;
        user.resetTokenExpiry = null;

        // Update the user in the database
        await usersContainer.items.upsert(user);

        context.res = { status: 200, body: { message: "Password has been reset successfully" } };

    } catch (err) {
        context.log("Reset password error:", err);
        context.res = { status: 500, body: { message: "Internal server error", error: err.message } };
    }
};
