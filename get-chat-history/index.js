const { getContainer } = require("../db");

const MESSAGE_CONTAINER = process.env.COSMOS_MESSAGE_CONTAINER;

module.exports = async function (context, req) {
    try {
        /* ================= VALIDATION ================= */

        const rawUserId = req.query.userId ?? req.body?.userId;
        const rawConversationId = req.query.conversationId ?? req.body?.conversationId;

        if (!rawUserId || !rawConversationId) {
            context.res = {
                status: 400,
                body: {
                    message: "userId and conversationId are required"
                }
            };
            return;
        }

        const userId = String(rawUserId);
        const conversationId = String(rawConversationId);

        /* ================= COSMOS QUERY ================= */

        const container = getContainer(MESSAGE_CONTAINER);

        const querySpec = {
            query: `
                SELECT c.id, c.message, c.response, c.timestamp
                FROM c
                WHERE c.userId = @userId
                  AND c.conversationId = @conversationId
                ORDER BY c.timestamp ASC
            `,
            parameters: [
                { name: "@userId", value: userId },
                { name: "@conversationId", value: conversationId }
            ]
        };

        const { resources } = await container.items
            .query(querySpec)
            .fetchAll();

        /* ================= RESPONSE ================= */

        context.res = {
            status: 200,
            body: {
                success: true,
                message: "Messages retrieved successfully",
                data: {
                    conversationId,
                    totalMessages: resources.length,
                    messages: resources
                }
            }
        };

    } catch (error) {
        context.log.error("Get single conversation error:", error);

        context.res = {
            status: 500,
            body: {
                message: "Internal server error"
            }
        };
    }
};
