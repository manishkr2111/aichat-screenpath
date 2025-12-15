const { getContainer } = require('../db');
const axios = require('axios');
const crypto = require('crypto');

/* ------------------ ENV ------------------ */

const MESSAGE_CONTAINER = process.env.COSMOS_MESSAGE_CONTAINER;
const MEMORY_CONTAINER = process.env.COSMOS_MEMORY_CONTAINER;
const OPENAI_KEY = process.env.OPENAI_KEY;
const OPENAI_ENDPOINT = process.env.OPENAI_ENDPOINT;

/* ------------------ OPENAI URLS - FIXED ------------------ */

const RESPONSES_URL =
    `${OPENAI_ENDPOINT}/openai/responses?api-version=2025-04-01-preview`;

const EMBEDDINGS_URL =
    `${OPENAI_ENDPOINT}/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-08-01-preview`;

/* ------------------ HELPERS ------------------ */

function uuidv4() {
    return crypto.randomUUID();
}

function extractTextFromResponse(data) {
    if (!data || !Array.isArray(data.output)) return null;

    for (const item of data.output) {
        if (Array.isArray(item.content)) {
            for (const block of item.content) {
                if (block.type === "output_text" && block.text) {
                    return block.text;
                }
            }
        }
    }
    return null;
}

async function createEmbedding(text) {
    const res = await axios.post(
        EMBEDDINGS_URL,
        {
            input: text
        },
        {
            headers: {
                "api-key": OPENAI_KEY,
                "Content-Type": "application/json"
            }
        }
    );

    return res.data.data[0].embedding;
}

/* ------------------ MAIN FUNCTION ------------------ */

module.exports = async function (context, req) {
    try {
        const { userId, message } = req.body || {};

        if (!userId || !message) {
            context.res = {
                status: 400,
                body: { message: "userId and message are required" }
            };
            return;
        }

        const messageContainer = getContainer(MESSAGE_CONTAINER);
        const memoryContainer = getContainer(MEMORY_CONTAINER);

        /* 1️⃣ SHORT-TERM MEMORY (LAST 5 CHATS) */
        const recentQuery = {
            query: `
        SELECT TOP 5 *
        FROM c
        WHERE c.userId = @userId
        ORDER BY c.timestamp DESC
      `,
            parameters: [{ name: "@userId", value: userId }]
        };

        const { resources: recentChats = [] } =
            await messageContainer.items.query(recentQuery).fetchAll();

        const shortTermContext = recentChats
            .reverse()
            .map(m => `User: ${m.message}\nAI: ${m.response}`)
            .join("\n");

        /* 2️⃣ LONG-TERM MEMORY (VECTOR SEARCH) */
        let longTermContext = "";

        try {
            const queryEmbedding = await createEmbedding(message);

            const memoryQuery = {
                query: `
                    SELECT TOP 5 c.content
                    FROM c
                    WHERE c.userId = @userId
                    ORDER BY VectorDistance(c.embedding, @embedding)
                    `,
                parameters: [
                    { name: "@userId", value: userId },
                    { name: "@embedding", value: queryEmbedding }
                ]
            };

            const { resources: memories = [] } =
                await memoryContainer.items.query(memoryQuery).fetchAll();

            longTermContext = memories
                .map(m => `- ${m.content}`)
                .join("\n");
        } catch (embeddingError) {
            context.log("Embedding/Memory search failed:", embeddingError.message);
            // Continue without long-term memory
        }

        /* 3️⃣ PROMPT */
        const prompt = `
            You are a helpful AI assistant.

            Long-term memory:
            ${longTermContext || "None"}

            Recent conversation:
            ${shortTermContext || "None"}

            User:
            ${message}

            Answer clearly.
            `;

        /* 4️⃣ CALL AZURE OPENAI */
        const aiApiResponse = await axios.post(
            RESPONSES_URL,
            {
                model: "gpt-5.2-chat",
                input: prompt
            },
            {
                headers: {
                    "api-key": OPENAI_KEY,
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );

        const aiResponse =
            extractTextFromResponse(aiApiResponse.data) ||
            "Sorry, I couldn't generate a response.";

        /* 5️⃣ SAVE SHORT-TERM CHAT */
        await messageContainer.items.create({
            id: uuidv4(),
            userId,
            message,
            response: aiResponse,
            timestamp: new Date().toISOString()
        });

        /* 6️⃣ MEMORY EXTRACTION */
        const memoryPrompt = `
            Extract important long-term memory.
            Return JSON ONLY.

            Message:
            "${message}"

            JSON:
            {
            "store": true/false,
            "content": "important memory"
            }
            `;

        try {
            const memoryDecisionResponse = await axios.post(
                RESPONSES_URL,
                {
                    model: "gpt-5.2-chat",
                    input: memoryPrompt
                },
                {
                    headers: {
                        "api-key": OPENAI_KEY,
                        "Content-Type": "application/json"
                    }
                }
            );

            const decisionText = extractTextFromResponse(memoryDecisionResponse.data);

            let decision = { store: false };

            try {
                const match = decisionText.match(/\{[\s\S]*\}/);
                if (match) decision = JSON.parse(match[0]);
            } catch (e) {
                context.log("Memory parse failed:", decisionText);
            }

            /* 7️⃣ SAVE LONG-TERM MEMORY */
            if (decision.store && decision.content) {
                const memoryEmbedding = await createEmbedding(decision.content);

                await memoryContainer.items.create({
                    id: uuidv4(),
                    userId,
                    content: decision.content,
                    embedding: memoryEmbedding,
                    createdAt: new Date().toISOString()
                });
            }
        } catch (memoryError) {
            context.log("Memory extraction failed:", memoryError.message);
            // Continue without saving memory
        }

        /* 8️⃣ RESPONSE */
        context.res = {
            status: 200,
            body: {
                success: true,
                message: "Chat successful",
                data: aiResponse,
                // longTermContext: longTermContext,
                // shortTermContext: shortTermContext
            }
        };

    } catch (err) {
        context.log("ERROR:", err?.response?.data || err);

        context.res = {
            status: 500,
            body: {
                message: "Internal server error",
                error: err.message,
                details: err?.response?.data || null
            }
        };
    }
};