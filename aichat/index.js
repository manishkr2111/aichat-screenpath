const { getContainer } = require("../db");
const SIYAN_SYSTEM_PROMPT = require('../prompts/system-siyan-reflect');
const axios = require("axios");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/* ================== ENV ================== */
const OPENAI_ENDPOINT_EMBEDDING = process.env.OPENAI_ENDPOINT_EMBEDDING;
const OPENAI_API_KEY_EMBEDDING = process.env.OPENAI_API_KEY_EMBEDDING;
const EMBEDDING_DEPLOYMENT = process.env.EMBEDDING_DEPLOYMENT;
const RESPONSES_URL_4_MODEL = process.env.OPENAI_ENDPOINT_CHAT_4_MODEL;
const OPENAI_KEY_CHAT_4_MODEL = process.env.OPENAI_KEY_CHAT_4_MODEL;
const MESSAGE_CONTAINER = process.env.COSMOS_MESSAGE_CONTAINER;
const MEMORY_CONTAINER = process.env.COSMOS_MEMORY_CONTAINER;
const MAX_TOKEN = process.env.MAX_TOKEN;
const TEMPERATURE = process.env.TEMPERATURE;
/* ================== COSMOS ================== */
const memoryContainer = getContainer(MEMORY_CONTAINER);
const messageContainer = getContainer(MESSAGE_CONTAINER);

/* ================== AXIOS INSTANCES ================== */
const embeddingClient = axios.create({
    baseURL: OPENAI_ENDPOINT_EMBEDDING,
    headers: {
        "api-key": OPENAI_API_KEY_EMBEDDING,
        "Content-Type": "application/json"
    },
    timeout: 5000,
    httpAgent: new (require('http').Agent)({ keepAlive: true }),
    httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

const chatClient = axios.create({
    headers: {
        "api-key": OPENAI_KEY_CHAT_4_MODEL,
        "Content-Type": "application/json"
    },
    timeout: 10000,
    httpAgent: new (require('http').Agent)({ keepAlive: true }),
    httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

/* ================== TIMING ================== */
function now() {
    return Number(process.hrtime.bigint()) / 1e6;
}

/* ================== AUTH ================== */
function verifyTokenFast(req) {
    try {
        const auth = req.headers.authorization;
        if (!auth) return null;
        const token = auth.split(" ")[1];
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        console.error("[AUTH ERROR]:", err.message);
        return null;
    }
}

/* ================== UTIL ================== */
function extractTextFromChatCompletion(data) {
    return data?.choices?.[0]?.message?.content?.trim() || null;
}

function generateDeterministicId(seed) {
    return crypto.createHash("sha256").update(seed).digest("hex").substring(0, 32);
}

/* ================== MEMORY RULES ================== */
const MEMORY_REGEX = /i am|i'm|i like|i love|i hate|vegetarian|vegan|allergic|diet|avoid|preference/i;
const FACT_REGEX = /i am|i'm|i like|i love|i hate|vegetarian|vegan|allergic|diet|avoid|preference/i;

function shouldSaveMemory(message) {
    const text = message.toLowerCase().trim();
    // Skip greetings
    if (/^(hi|hello|hey|ok|thanks|thank you|yes|no)$/i.test(text)) return false;
    return MEMORY_REGEX.test(text);
}

function shouldRetrieveMemory(message) {
    const text = message.toLowerCase().trim();
    // Skip very short greetings
    if (/^(hi|hello|hey)$/i.test(text)) return false;
    // Retrieve for questions about history or anything longer
    return text.length > 10 || /previous|before|earlier|last time|remember|history|what did|what was/i.test(text);
}

function isLikelyFact(message) {
    return FACT_REGEX.test(message.toLowerCase());
}

/* ================== EMBEDDINGS ================== */
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 500;

async function generateEmbedding(text) {
    if (embeddingCache.has(text)) {
        console.log(`[CACHE HIT] Embedding for: "${text.substring(0, 30)}..."`);
        return embeddingCache.get(text);
    }

    const tStart = now();
    const { data } = await embeddingClient.post(
        `/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=2024-10-01-preview`,
        { input: [text] }
    );

    const embedding = data.data[0].embedding;
    console.log(`[EMBEDDING] Generated in ${(now() - tStart).toFixed(2)}ms - dim: ${embedding.length}`);

    // LRU cache
    if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
    }
    embeddingCache.set(text, embedding);

    return embedding;
}

/* ================== VECTOR SEARCH ================== */
async function vectorSearchUnified(userId, embedding) {
    const tStart = now();

    // ✅ Get TOP 5 results without distance filter in query for better debugging
    const query = `
        SELECT TOP 5
            c.userMessage,
            c.aiResponse,
            c.memoryCategory,
            VectorDistance(c.embedding, @embedding) AS score
        FROM c
        WHERE c.userId = @userId
        ORDER BY VectorDistance(c.embedding, @embedding)
    `;

    const { resources } = await memoryContainer.items
        .query(
            {
                query,
                parameters: [
                    { name: "@userId", value: userId },
                    { name: "@embedding", value: embedding }
                ]
            },
            {
                partitionKey: userId,
                maxItemCount: 5
            }
        )
        .fetchAll();

    // ✅ Adaptive threshold based on dataset size
    // <1000 vectors: More lenient (0.8) due to full scan inaccuracy
    // >1000 vectors: Stricter (0.6) when DiskANN is active
    const threshold = 0.8;
    const filtered = resources.filter(r => r.score < threshold);

    if (resources.length > 0) {
        console.log(`[VECTOR SEARCH] ${(now() - tStart).toFixed(2)}ms - Found: ${resources.length}, Filtered: ${filtered.length}`);
        console.log(`[SCORES] Range: ${resources[0].score.toFixed(4)} to ${resources[resources.length - 1].score.toFixed(4)}`);
        // Log what was found for debugging
        resources.forEach((r, i) => {
            const kept = r.score < threshold ? "✓" : "✗";
            console.log(`  [${i}] ${kept} ${r.score.toFixed(4)} - "${r.userMessage.substring(0, 40)}..."`);
        });
    } else {
        console.log(`[VECTOR SEARCH] ${(now() - tStart).toFixed(2)}ms - ⚠️ Found: 0 memories for userId: ${userId}`);
    }

    return filtered;
}

/* ================== CONTEXT BUILDER ================== */
function buildContext(memories) {
    if (!memories || memories.length === 0) {
        return { facts: "None", contextText: "None" };
    }

    let facts = "";
    let contextText = "";

    for (const m of memories) {
        if (m.memoryCategory === "fact") {
            facts += `- ${m.userMessage}\n`;
        } else if (m.memoryCategory === "conversation") {
            contextText += `- ${m.userMessage} → ${m.aiResponse}\n`;
        }
    }

    return {
        facts: facts || "None",
        contextText: contextText || "None"
    };
}

/* ================== MAIN ================== */
module.exports = async function (context, req) {
    const t0 = now();
    console.log("[REQUEST START]");

    try {
        // Auth
        const tAuth = now();
        const user = verifyTokenFast(req);
        console.log('userId', user.id);

        console.log(`[AUTH] ${(now() - tAuth).toFixed(2)}ms`);

        if (!user) {
            context.res = { status: 401, body: { message: "Unauthorized" } };
            return;
        }

        const { userId, message } = req.body || {};
        if (!userId || !message) {
            context.res = { status: 400, body: { message: "userId and message required" } };
            return;
        }

        console.log(`[USER] ${userId} | [MSG] "${message}"`);

        /* ===== RETRIEVAL (if needed) ===== */
        let facts = "None";
        let contextText = "None";
        let embedding = null;

        if (shouldRetrieveMemory(message)) {
            const tRetrieval = now();

            embedding = await generateEmbedding(message);
            const memories = await vectorSearchUnified(userId, embedding);

            if (memories.length > 0) {
                const ctx = buildContext(memories);
                facts = ctx.facts;
                contextText = ctx.contextText;
            }

            console.log(`[RETRIEVAL] ${(now() - tRetrieval).toFixed(2)}ms - Retrieved ${memories.length} memories`);
        } else {
            console.log("[RETRIEVAL] Skipped - message doesn't need memory retrieval");
        }

        /* ===== AI GENERATION ===== */
        const tAI = now();
        const prompt = `User preferences:\n${facts}\n\nRecent context:\n${contextText}\n\nUser:\n${message}`;
        console.log("[PROMPT]", prompt);

        const { data } = await chatClient.post(RESPONSES_URL_4_MODEL, {
            messages: [
                { role: "system", content: SIYAN_SYSTEM_PROMPT },
                { role: "user", content: prompt }
            ],
            temperature: TEMPERATURE || 0.3,
            max_completion_tokens: MAX_TOKEN || 100
        });

        const aiResponse = extractTextFromChatCompletion(data) || "Sorry, I couldn't generate a response.";
        console.log(`[AI] ${(now() - tAI).toFixed(2)}ms`);

        /* ===== PERSIST DATA (GUARANTEED) ===== */
        const tSave = now();
        const timestamp = new Date().toISOString();
        const messageId = generateDeterministicId(`${userId}-${timestamp}-${message}`);

        //  Save message (fire-and-forget)
        const messageSave = messageContainer.items.create({
            id: messageId,
            userId,
            message,
            response: aiResponse,
            timestamp
        }).then(() => {
            console.log(`[SAVE] Message: ${messageId}`);
        }).catch(e => {
            console.error(`[SAVE ERROR - Message]:`, e.message);
        });

        //  Save memory SYNCHRONOUSLY (critical path) - only if it matches save criteria
        if (shouldSaveMemory(message)) {
            const memoryId = generateDeterministicId(`${userId}-memory-${timestamp}-${message}`);
            const memoryEmbedding = embedding || await generateEmbedding(message);
            const category = isLikelyFact(message) ? "fact" : "conversation";

            console.log(`[MEMORY] Saving as "${category}"...`);

            await memoryContainer.items.create({
                id: memoryId,
                userId,
                memoryCategory: category,
                userMessage: message,
                aiResponse,
                embedding: memoryEmbedding,
                createdAt: timestamp
            });

            console.log(`[SAVE] ✅ Memory: ${memoryId} (${category})`);
        } else {
            console.log("[SAVE] Memory save skipped - doesn't match save criteria");
        }

        console.log(`[SAVE] ${(now() - tSave).toFixed(2)}ms`);

        // Wait for message save (optional - can remove for 100ms faster response)
        await messageSave;

        /* ===== RESPOND ===== */
        console.log(`[TOTAL] ${(now() - t0).toFixed(2)}ms`);
        console.log("=".repeat(60));

        context.res = {
            status: 200,
            body: {
                success: true,
                data: aiResponse
            }
        };

    } catch (err) {
        console.error("[ERROR]:", err?.response?.data || err.message || err);
        console.error("[STACK]:", err.stack);
        context.res = {
            status: 500,
            body: { message: "Internal server error" }
        };
    }
};