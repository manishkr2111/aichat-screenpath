const { CosmosClient } = require("@azure/cosmos");

module.exports = async function (context, req) {
  const client = new CosmosClient({
    endpoint: process.env.COSMOS_DB_ENDPOINT,
    key: process.env.COSMOS_DB_KEY
  });

  const database = client.database(process.env.COSMOS_DB_NAME);

  try {
    // ✅ Use DiskANN index - best for production scale
    const { container } = await database.containers.create({
      id: "chat_memory_data",
      partitionKey: {
        paths: ["/userId"]
      },
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [
          {
            path: "/embedding",
            dataType: "float32",
            dimensions: 1536,
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
            type: "diskANN",  // ✅ DiskANN - production-grade performance
            quantizationByteSize: 128  // Balances accuracy vs latency
          }
        ]
      }
    });

    context.res = {
      status: 200,
      body: {
        message: "✅ Container created with DiskANN index (production-ready)",
        containerId: container.id,
        note: "DiskANN offers <20ms latency and scales to billions of vectors"
      }
    };
  } catch (error) {
    context.log("Error:", error);
    context.res = {
      status: 500,
      body: {
        message: "❌ Failed to create container",
        error: error.message
      }
    };
  }
};