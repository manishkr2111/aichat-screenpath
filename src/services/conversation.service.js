const { getContainer } = require("../../db");

const COUNTER_CONTAINER = process.env.CONVERSATION_CONTAINER;
const COUNTER_ID = "conversation_counter";

async function getNextConversationId(userId) {
    const container = getContainer(COUNTER_CONTAINER);

    console.log("Getting next conversation id...");

    const response = await container
        .item(COUNTER_ID, userId)
        .read()
        .catch(() => ({ resource: null }));

    const resource = response.resource;

    console.log("resource:", resource);

    // 🔐 Handle missing or corrupted counter
    if (!resource || typeof resource.value !== "number") {
        await container.items.create({
            id: COUNTER_ID,
            userId,
            value: 1
        });
        return "1"; 
    }

    const next = resource.value + 1;

    await container.item(COUNTER_ID, userId).replace({
        id: COUNTER_ID,
        userId,
        value: next
    });

    return String(next); // ✅ string
}
module.exports = {
    getNextConversationId
};