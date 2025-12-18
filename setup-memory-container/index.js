const { CosmosClient } = require("@azure/cosmos");

module.exports = async function (context, req) {
    const client = new CosmosClient({
        endpoint: process.env.COSMOS_DB_ENDPOINT,
        key: process.env.COSMOS_DB_KEY
    });

    const database = client.database(process.env.COSMOS_DB_NAME);

    try {
        const { container } = await database.containers.createIfNotExists({
            id: "chat_memory_data",
            partitionKey: {
                paths: ["/userId"]
            },
            vectorEmbeddingPolicy: {
                vectorEmbeddings: [
                    {
                        path: "/embedding",
                        dataType: "float32",
                        dimensions: 3072,
                        distanceFunction: "cosine"
                    }
                ]
            },
            indexingPolicy: {
                indexingMode: "consistent",
                automatic: true,
                includedPaths: [{ path: "/*" }],
                excludedPaths: [{ path: "/\"_etag\"/?" }],
                vectorIndexes: [
                    {
                        path: "/embedding",
                        type: "quantizedFlat"
                    }
                ]
            }
        });

        context.res = {
            status: 200,
            body: { 
                message: "✅ chat_memory_data container configured successfully!",
                containerId: container.id
            }
        };
    } catch (error) {
        context.log("Error:", error);
        context.res = {
            status: 500,
            body: { 
                message: "❌ Failed to configure container",
                error: error.message 
            }
        };
    }
};