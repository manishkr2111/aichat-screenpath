const { getContainer } = require('../db');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

module.exports = async function (context, req) {
    try {
        const { email } = req.body;
        if (!email) {
            context.res = { status: 400, body: { message: "Email is required" } };
            return;
        }

        const usersContainer = getContainer(process.env.COSMOS_USER_CONTAINER);

        // Find user
        const querySpec = {
            query: "SELECT * FROM c WHERE c.email = @email",
            parameters: [{ name: "@email", value: email }]
        };

        const { resources: users } = await usersContainer.items
            .query(querySpec)
            .fetchAll();

        if (users.length === 0) {
            // Return explicit message if user not found
            context.res = {
                status: 404,
                body: { message: "User not found" }
            };
            return;
        }

        const user = users[0];

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto
            .createHash('sha256')
            .update(resetToken)
            .digest('hex');

        user.resetToken = hashedToken;
        user.resetTokenExpiry = Date.now() + 15 * 60 * 1000; // 15 minutes

        await usersContainer.items.upsert(user);

        // SMTP transporter
        const transporter = nodemailer.createTransport({
            host: process.env.MAIL_HOST,
            port: process.env.MAIL_PORT,
            secure: false,
            auth: {
                user: process.env.MAIL_USERNAME,
                pass: process.env.MAIL_PASSWORD
            }
        });

        const baseUrl = process.env.BASE_URL;
        const resetLink = `${baseUrl}/reset-password-page?token=${resetToken}`;


        await transporter.sendMail({
            from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
            to: user.email,
            subject: "Reset your password",
            html: `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <title>Reset Password</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            background-color: #f4f6f8;
                            margin: 0;
                            padding: 0;
                        }
                        .container {
                            max-width: 600px;
                            margin: 50px auto;
                            background-color: #ffffff;
                            padding: 30px;
                            border-radius: 8px;
                            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
                            text-align: center;
                        }
                        h2 {
                            color: #333333;
                        }
                        p {
                            color: #555555;
                            font-size: 16px;
                            line-height: 1.5;
                        }
                        a.button {
                            display: inline-block;
                            padding: 12px 25px;
                            margin-top: 20px;
                            background-color: #007bff;
                            color: #ffffff !important;
                            text-decoration: none;
                            border-radius: 6px;
                            font-size: 16px;
                        }
                        a.button:hover {
                            background-color: #0056b3;
                        }
                        .footer {
                            margin-top: 30px;
                            font-size: 12px;
                            color: #999999;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>Password Reset Request</h2>
                        <p>Hello,</p>
                        <p>We received a request to reset your password. Click the button below to set a new password. This link is valid for 15 minutes.</p>
                        <a href="${resetLink}" class="button">Reset Password</a>
                        <p>If you did not request a password reset, please ignore this email.</p>
                        <div class="footer">
                            &copy; ${new Date().getFullYear()} ${process.env.MAIL_FROM_NAME}. All rights reserved.
                        </div>
                    </div>
                </body>
                </html>
                `
        });


        context.res = {
            status: 200,
            body: { message: "A password reset link has been sent." }
        };

    } catch (err) {
        context.log("Forgot password error:", err);
        context.res = {
            status: 500,
            body: { message: "Internal server error" }
        };
    }
};
