const { getContainer } = require("../db");
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

/* ================== COSMOS ================== */
const memoryContainer = getContainer(MEMORY_CONTAINER);
const messageContainer = getContainer(MESSAGE_CONTAINER);

/* ================== AXIOS INSTANCES (REUSE CONNECTIONS) ================== */
const embeddingClient = axios.create({
    baseURL: OPENAI_ENDPOINT_EMBEDDING,
    headers: {
        "api-key": OPENAI_API_KEY_EMBEDDING,
        "Content-Type": "application/json"
    },
    timeout: 3000, // Aggressive timeout
    maxRedirects: 0,
    httpAgent: new (require('http').Agent)({ keepAlive: true }),
    httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

const chatClient = axios.create({
    baseURL: RESPONSES_URL_4_MODEL,
    headers: {
        "api-key": OPENAI_KEY_CHAT_4_MODEL,
        "Content-Type": "application/json"
    },
    timeout: 8000,
    maxRedirects: 0,
    httpAgent: new (require('http').Agent)({ keepAlive: true }),
    httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

/* ================== TIMING ================== */
function now() {
    return Number(process.hrtime.bigint()) / 1e6;
}
function logStep(label, start) {
    console.log(`[LATENCY] ${label}: ${(now() - start).toFixed(2)} ms`);
}

/* ================== AUTH ================== */
function verifyTokenFast(req) {
    try {
        const auth = req.headers.authorization;
        if (!auth) return null;

        const token = auth.split(" ")[1];
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        console.error("JWT ERROR:", err.message);
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
function shouldSaveMemory(message) {
    return MEMORY_REGEX.test(message);
}

/* ================== EMBEDDINGS ================== */
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 500;

async function generateEmbedding(text) {
    if (embeddingCache.has(text)) return embeddingCache.get(text);

    const { data } = await embeddingClient.post(
        `/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=2024-10-01-preview`,
        { input: [text], dimensions: 1536 } // Specify dimensions explicitly
    );

    const embedding = data.data[0].embedding;
    
    // LRU cache management
    if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
    }
    embeddingCache.set(text, embedding);
    
    return embedding;
}

/* ================== VECTOR SEARCH (OPTIMIZED) ================== */
async function vectorSearchUnified(userId, embedding) {
    // Simplified query with minimal projection
    const query = `
        SELECT TOP 3
            c.userMessage,
            c.aiResponse,
            c.memoryCategory
        FROM c
        WHERE c.userId = @userId
          AND VectorDistance(c.embedding, @embedding) < 0.6
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
                maxItemCount: 3 // Limit results
            }
        )
        .fetchAll();

    return resources;
}

/* ================== CONTEXT BUILDER (OPTIMIZED) ================== */
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

/* ================== BACKGROUND SAVE ================== */
function persistDataInBackground({ userId, message, aiResponse }) {
    const timestamp = new Date().toISOString();

    setImmediate(async () => {
        try {
            const messageId = generateDeterministicId(`${userId}-${timestamp}-${message}`);
            
            const saveMessage = messageContainer.items.create({
                id: messageId,
                userId,
                message,
                response: aiResponse,
                timestamp
            });

            let saveMemory = Promise.resolve();
            if (shouldSaveMemory(message)) {
                saveMemory = (async () => {
                    const embedding = await generateEmbedding(message);
                    await memoryContainer.items.create({
                        id: generateDeterministicId(`${userId}-memory-${timestamp}-${message}`),
                        userId,
                        memoryCategory: "fact",
                        userMessage: message,
                        aiResponse,
                        embedding,
                        createdAt: timestamp
                    });
                })();
            }

            await Promise.allSettled([saveMessage, saveMemory]);
        } catch (err) {
            console.error("[BG SAVE ERROR]", err.message);
        }
    });
}

/* ================== MAIN (ULTRA OPTIMIZED) ================== */
module.exports = async function (context, req) {

    try {
        // Fast auth check
        const user = verifyTokenFast(req);
        if (!user) {
            context.res = { status: 401, body: { message: "Unauthorized" } };
            return;
        }

        const { userId, message } = req.body || {};
        if (!userId || !message) {
            context.res = { status: 400, body: { message: "userId and message required" } };
            return;
        }

        /*  PARALLEL: Embedding+Search AND AI Call start simultaneously */
        
        const retrievalPromise = generateEmbedding(message)
            .then(emb => vectorSearchUnified(userId, emb))
            .then(memories => buildContext(memories));

        // Start AI call immediately with minimal context (will use retrieved context if ready)
        const aiPromise = (async () => {
            const { facts, contextText } = await retrievalPromise;
            
            const prompt = `User preferences:\n${facts}\n\nRecent context:\n${contextText}\n\nUser:\n${message}\n\nReply in 1–2 short sentences.`;
            
            const { data } = await chatClient.post('', {
                messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 100,
                stream: false
            });
            
            return extractTextFromChatCompletion(data) || "Sorry, I couldn't generate a response.";
        })();

        const aiResponse = await aiPromise;

        /*  BACKGROUND SAVE */
        persistDataInBackground({ userId, message, aiResponse });

        context.res = {
            status: 200,
            body: {
                success: true,
                data: aiResponse,
            }
        };


    } catch (err) {
        console.error("ERROR:", err?.response?.data || err.message || err);
        context.res = { 
            status: 500, 
            body: { message: "Internal server error" }
        };
    }
};