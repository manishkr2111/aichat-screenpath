const { getContainer } = require("../db");
const axios = require("axios");
const verifyToken = require("../src/verifyToken");

/* ================== ENV ================== */

const OPENAI_ENDPOINT_EMBEDDING = process.env.OPENAI_ENDPOINT_EMBEDDING;
const OPENAI_API_KEY_EMBEDDING = process.env.OPENAI_API_KEY_EMBEDDING;
const OPENAI_ENDPOINT_CHAT = process.env.OPENAI_ENDPOINT_CHAT;
const OPENAI_KEY_CHAT = process.env.OPENAI_KEY_CHAT;
const EMBEDDING_DEPLOYMENT = process.env.EMBEDDING_DEPLOYMENT;

const MESSAGE_CONTAINER = process.env.COSMOS_MESSAGE_CONTAINER;
const MEMORY_CONTAINER = process.env.COSMOS_MEMORY_CONTAINER;
const USER_CONTAINER = process.env.COSMOS_USER_CONTAINER;

const RESPONSES_URL =
    `${OPENAI_ENDPOINT_CHAT}/openai/responses?api-version=2025-04-01-preview`;

/* ================== UTIL ================== */

function extractTextFromResponse(data) {
    if (!data?.output) return null;
    for (const item of data.output) {
        for (const block of item.content || []) {
            if (block.type === "output_text") return block.text;
        }
    }
    return null;
}

/* ================== FAST FACT DETECTION ================== */

// cheap + fast (NO AI)
function isLikelyFact(message) {
    return /i am|i'm|i like|i love|i hate|vegetarian|vegan|allergic|diet|avoid|preference/i
        .test(message.toLowerCase());
}

/* ================== EMBEDDINGS ================== */

async function generateEmbedding(text) {
    const res = await axios.post(
        `${OPENAI_ENDPOINT_EMBEDDING}/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=2024-10-01-preview`,
        { input: [text] },
        {
            headers: {
                "api-key": OPENAI_API_KEY_EMBEDDING,
                "Content-Type": "application/json"
            }
        }
    );
    return res.data.data[0].embedding;
}

/* ================== MEMORY ================== */

async function saveMemoryBackground(userId, message, aiResponse) {
    try {
        const memoryContainer = getContainer(MEMORY_CONTAINER);

        const isFact = isLikelyFact(message);
        const embedding = await generateEmbedding(message);
        const id = Math.floor(10000 + Math.random() * 90000).toString();
        await memoryContainer.items.create({
            id,
            userId,
            memoryCategory: isFact ? "fact" : "conversation",
            userMessage: message,
            aiResponse,
            embedding,
            createdAt: new Date().toISOString()
        });

    } catch (err) {
        console.error("Background memory save failed:", err.message);
    }
}

/* ================== READ MEMORY (FAST) ================== */

async function getUserFacts(userId) {
    const memoryContainer = getContainer(MEMORY_CONTAINER);

    const { resources } = await memoryContainer.items.query({
        query: `
            SELECT c.userMessage FROM c
            WHERE c.userId = @userId
            AND c.memoryCategory = "fact"
            ORDER BY c.createdAt DESC
            OFFSET 0 LIMIT 5
        `,
        parameters: [{ name: "@userId", value: userId }]
    }).fetchAll();

    return resources.length
        ? resources.map(r => `- ${r.userMessage}`).join("\n")
        : "None";
}

async function getRecentConversation(userId) {
    const memoryContainer = getContainer(MEMORY_CONTAINER);

    const { resources } = await memoryContainer.items.query({
        query: `
            SELECT c.userMessage, c.aiResponse FROM c
            WHERE c.userId = @userId
            AND c.memoryCategory = "conversation"
            ORDER BY c.createdAt DESC
            OFFSET 0 LIMIT 3
        `,
        parameters: [{ name: "@userId", value: userId }]
    }).fetchAll();

    return resources.length
        ? resources.map(r => `- ${r.userMessage} → ${r.aiResponse}`).join("\n")
        : "None";
}

/* ================== MAIN ================== */

module.exports = async function (context, req) {
    try {
        const user = await verifyToken(req);
        if (!user) {
            context.res = { status: 401, body: { message: "Unauthorized" } };
            return;
        }

        const { userId, message } = req.body || {};
        if (!userId || !message) {
            context.res = { status: 400, body: { message: "userId and message required" } };
            return;
        }

        /* PARALLEL READS */
        const [facts, recentContext] = await Promise.all([
            getUserFacts(userId),
            getRecentConversation(userId)
        ]);

        const prompt = `
            You are a helpful AI assistant.

            USER FACTS (always follow):
            ${facts}

            RECENT CONTEXT:
            ${recentContext}

            Rules:
            - Always respect diet & preferences

            User:
            ${message}

            Answer clearly.
        `;

        /* OPENAI CHAT */
        const aiRes = await axios.post(
            RESPONSES_URL,
            { model: "gpt-5.2-chat", input: prompt },
            {
                headers: {
                    "api-key": OPENAI_KEY_CHAT,
                    "Content-Type": "application/json"
                }
            }
        );

        const aiResponse =
            extractTextFromResponse(aiRes.data) ||
            "Sorry, I couldn't generate a response.";

        /* SEND RESPONSE IMMEDIATELY */
        context.res = {
            status: 200,
            body: {
                success: true,
                data: aiResponse
            }
        };

        /* BACKGROUND TASKS (NO WAIT) */
        setImmediate(async () => {
            const messageContainer = getContainer(MESSAGE_CONTAINER);
            const id = Math.floor(10000 + Math.random() * 90000).toString();
            await messageContainer.items.create({
                id,
                userId,
                message,
                response: aiResponse,
                timestamp: new Date().toISOString()
            });

            await saveMemoryBackground(userId, message, aiResponse);
        });

    } catch (err) {
        context.log("ERROR:", err?.response?.data || err);
        context.res = { status: 500, body: { message: "Internal server error" } };
    }
};
