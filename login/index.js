const { getContainer } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = async function (context, req) {
    try {
        context.log('Login function triggered');

        // Check environment variables
        const JWT_SECRET = process.env.JWT_SECRET;
        const containerName = process.env.COSMOS_USER_CONTAINER;

        if (!JWT_SECRET) {
            context.res = {
                status: 500,
                body: { message: "Server configuration error: JWT_SECRET missing" }
            };
            return;
        }

        if (!containerName) {
            context.res = {
                status: 500,
                body: { message: "Server configuration error: COSMOS_USER_CONTAINER missing" }
            };
            return;
        }

        // Get users container dynamically
        const usersContainer = getContainer(containerName);

        // Parse request body
        const { email, password } = req.body;

        // Validate input
        if (!email || !password) {
            context.res = {
                status: 400,
                body: { message: "Email and password are required" }
            };
            return;
        }

        context.log('Querying for user with email:', email);

        // Check if user exists
        const querySpec = {
            query: "SELECT * FROM c WHERE c.email = @email",
            parameters: [{ name: "@email", value: email }]
        };

        const { resources: users } = await usersContainer.items.query(querySpec).fetchAll();

        if (users.length === 0) {
            context.log('User not found');
            context.res = {
                status: 401,
                body: { message: "Invalid credentials" }
            };
            return;
        }

        const user = users[0];
        context.log('User found, verifying password');

        // Compare passwords
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            context.log('Password mismatch');
            context.res = {
                status: 401,
                body: { message: "Invalid credentials" }
            };
            return;
        }

        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await usersContainer.items.upsert(user);
        // Generate JWT token (expires in 1 day)
        const token = jwt.sign(
            {
                id: user.id,
                name: user.name,
                email: user.email,
                tokenVersion: user.tokenVersion
            },
            JWT_SECRET,
            { expiresIn: "1d" }
        );

        context.log('Login successful for user:', user.email);

        context.res = {
            status: 200,
            body: {
                success: true,
                message: "Login successful",
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    token: token,
                }
            }
        };

    } catch (err) {
        context.log('ERROR in login function:', err);
        context.res = {
            status: 500,
            body: {
                message: "Internal server error",
                error: err.message
            }
        };
    }
};