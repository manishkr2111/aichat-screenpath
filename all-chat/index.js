const { getContainer } = require("../db");

const MESSAGE_CONTAINER = process.env.COSMOS_MESSAGE_CONTAINER;

module.exports = async function (context, req) {
    try {
        const rawUserId = req.query.userId ?? req.body?.userId;

        if (!rawUserId) {
            context.res = {
                status: 400,
                body: { message: "userId is required" }
            };
            return;
        }

        const userId = String(rawUserId);
        const container = getContainer(MESSAGE_CONTAINER);

        /* ================= COSMOS QUERY ================= */

        const querySpec = {
            query: `
                SELECT c.conversationId, c.message, c.timestamp
                FROM c
                WHERE c.userId = @userId
                ORDER BY c.timestamp ASC
            `,
            parameters: [
                { name: "@userId", value: userId }
            ]
        };

        const { resources } = await container.items
            .query(querySpec)
            .fetchAll();

        /* ================= PROCESS DATA ================= */

        const conversationsMap = new Map();

        for (const item of resources) {
            const conversationId = String(item.conversationId);

            if (!conversationsMap.has(conversationId)) {
                // First message of conversation
                conversationsMap.set(conversationId, {
                    userId,
                    conversationId,
                    firstMessage: item.message,
                    timestamp: item.timestamp,
                    totalMessages: 1
                });
            } else {
                // Increment message count
                conversationsMap.get(conversationId).totalMessages += 1;
            }
        }

        const conversations = Array.from(conversationsMap.values());

        /* ================= RESPONSE ================= */

        context.res = {
            status: 200,
            body: {
                success: true,
                data: conversations
            }
        };

    } catch (err) {
        context.log.error(err);
        context.res = {
            status: 500,
            body: { message: "Internal server error" }
        };
    }
};
