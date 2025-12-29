const { getContainer } = require("../db");

const MESSAGE_CONTAINER = process.env.COSMOS_MESSAGE_CONTAINER;

module.exports = async function (context, req) {
    try {
        const rawUserId = req.query.userId ?? req.body?.userId;
        if (rawUserId === undefined || rawUserId === null || rawUserId === "") {
            context.res = {
                status: 400,
                body: { message: "userId is required" }
            };
            return;
        }
        const userId = String(rawUserId);
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

        const { resources } = await container.items
            .query(querySpec)
            .fetchAll();

        resources.sort((a, b) => a.timestamp - b.timestamp);

        // Pick first message per conversation
        const conversationsMap = new Map();
        for (const item of resources) {
            if (!conversationsMap.has(item.conversationId)) {
                conversationsMap.set(item.conversationId, {
                    userId: userId,
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