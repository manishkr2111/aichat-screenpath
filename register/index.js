const { getContainer } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = async function (context, req) {
    try {
        context.log('Register function triggered');

        const JWT_SECRET = process.env.JWT_SECRET;
        const containerName = process.env.COSMOS_USER_CONTAINER;

        if (!JWT_SECRET || !containerName) {
            context.res = {
                status: 500,
                body: { message: "Server configuration error" }
            };
            return;
        }

        const usersContainer = getContainer(containerName);
        const { name, email, password } = req.body;

        // Validate input
        if (!name || !email || !password) {
            context.res = {
                status: 400,
                body: { message: "Name, email, and password are required" }
            };
            return;
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            context.res = {
                status: 400,
                body: { message: "Invalid email format" }
            };
            return;
        }

        // Validate password length
        if (password.length < 6) {
            context.res = {
                status: 400,
                body: { message: "Password must be at least 6 characters long" }
            };
            return;
        }

        // Check if user already exists
        const querySpec = {
            query: "SELECT * FROM c WHERE c.email = @email",
            parameters: [{ name: "@email", value: email }]
        };

        const { resources: existingUsers } = await usersContainer.items.query(querySpec).fetchAll();

        if (existingUsers.length > 0) {
            context.res = {
                status: 409,
                body: { message: "User with this email already exists" }
            };
            return;
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Get max id - improved query
        const queryMaxId = {
            query: "SELECT c.id FROM c ORDER BY c.id DESC OFFSET 0 LIMIT 1"
        };
        
        let newId = 1;
        try {
            const { resources: maxIdResult } = await usersContainer.items.query(queryMaxId).fetchAll();
            
            if (maxIdResult.length > 0 && maxIdResult[0].id) {
                const currentMaxId = parseInt(maxIdResult[0].id);
                if (!isNaN(currentMaxId)) {
                    newId = currentMaxId + 1;
                }
            }
        } catch (idError) {
            context.log('Error getting max ID, using default:', idError);
            // If query fails, just use newId = 1
        }

        // Create new user
        const newUser = {
            id: newId.toString(), // Cosmos DB id must be string
            name,
            email,
            password: hashedPassword,
            createdAt: new Date().toISOString()
        };

        // Save to database
        const { resource: createdUser } = await usersContainer.items.create(newUser);

        context.res = {
            status: 201,
            body: {
                success: true,
                message: "User registered successfully",
                user: {
                    id: createdUser.id,
                    name: createdUser.name,
                    email: createdUser.email,
                }
            }
        };

    } catch (err) {
        context.log('Register error:', err);
        context.res = {
            status: 500,
            body: {
                message: "Internal server error",
                error: err.message
            }
        };
    }
};