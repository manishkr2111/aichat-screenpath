const { getContainer } = require("../db");

const MESSAGE_CONTAINER = process.env.COSMOS_MESSAGE_CONTAINER;

module.exports = async function (context, req) {
    try {
        const userId = String(req.query.userId || req.body.userId);
        if (!userId) {
            context.res = { status: 400, body: { message: "userId is required" } };
            return;
        }

        const container = getContainer(MESSAGE_CONTAINER);

        // Query all messages of the user
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

        const { resources } = await container.items.query(querySpec, { partitionKey: userId }).fetchAll();

        // Pick first message per conversation
        const conversationsMap = new Map();
        for (const item of resources) {
            if (!conversationsMap.has(item.conversationId)) {
                conversationsMap.set(item.conversationId, {
                    conversationId: item.conversationId,
                    firstMessage: item.message,
                    timestamp: item.timestamp
                });
            }
        }

        const conversations = Array.from(conversationsMap.values());

        context.res = {
            status: 200,
            body: { success: true, data: conversations }
        };

    } catch (err) {
        console.error(err);
        context.res = {
            status: 500,
            body: { message: "Internal server error" }
        };
    }
};
