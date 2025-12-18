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

/* ================== VECTOR SEARCH (NEW!) ================== */

async function vectorSearchMemory(userId, queryText, category = null, limit = 5) {
    const memoryContainer = getContainer(MEMORY_CONTAINER);

    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(queryText);

    // Build query with optional category filter
    let query = `
        SELECT TOP @limit 
            c.userMessage, 
            c.aiResponse,
            c.memoryCategory,
            VectorDistance(c.embedding, @embedding) AS similarityScore
        FROM c
        WHERE c.userId = @userId
    `;

    const parameters = [
        { name: "@userId", value: userId },
        { name: "@embedding", value: queryEmbedding },
        { name: "@limit", value: limit }
    ];

    if (category) {
        query += ` AND c.memoryCategory = @category`;
        parameters.push({ name: "@category", value: category });
    }

    query += ` ORDER BY VectorDistance(c.embedding, @embedding)`;

    const { resources } = await memoryContainer.items.query({
        query,
        parameters
    }).fetchAll();

    return resources;
}

/* ================== READ MEMORY (ENHANCED WITH VECTOR SEARCH) ================== */

async function getUserFacts(userId, currentMessage) {
    // Use vector search to find RELEVANT facts based on current message
    const results = await vectorSearchMemory(userId, currentMessage, "fact", 5);

    return results.length
        ? results.map(r => `- ${r.userMessage} (relevance: ${(1 - r.similarityScore).toFixed(2)})`).join("\n")
        : "None";
}

async function getRelevantContext(userId, currentMessage) {
    // Use vector search to find RELEVANT past conversations
    const results = await vectorSearchMemory(userId, currentMessage, "conversation", 3);

    return results.length
        ? results.map(r => `- ${r.userMessage} → ${r.aiResponse}`).join("\n")
        : "None";
}

/* ================== FALLBACK: GET ALL FACTS (OPTIONAL) ================== */

async function getAllUserFacts(userId) {
    const memoryContainer = getContainer(MEMORY_CONTAINER);

    const { resources } = await memoryContainer.items.query({
        query: `
            SELECT c.userMessage FROM c
            WHERE c.userId = @userId
            AND c.memoryCategory = "fact"
            ORDER BY c.createdAt DESC
        `,
        parameters: [{ name: "@userId", value: userId }]
    }).fetchAll();

    return resources.length
        ? resources.map(r => `- ${r.userMessage}`).join("\n")
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

        /* PARALLEL VECTOR SEARCHES - NOW CONTEXT-AWARE! */
        const [facts, recentContext] = await Promise.all([
            getUserFacts(userId, message),
            getRelevantContext(userId, message)
        ]);

        const prompt = `
            You are a helpful AI assistant.

            RELEVANT USER FACTS (from semantic search):
            ${facts}

            RELEVANT PAST CONTEXT (from semantic search):
            ${recentContext}

            Rules:
            - Always respect diet & preferences
            - Use the relevant context above to provide personalized responses

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
                meggase:"response received successfully",
                data: aiResponse,
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