const { CosmosClient } = require("@azure/cosmos");

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_NAME;

// console.log('DB Config:');
// console.log('Endpoint:', endpoint);
// console.log('Database:', databaseId);

const client = new CosmosClient({ endpoint, key });
const database = client.database(databaseId);

// Function to get any container dynamically
const getContainer = (containerName) => {
    console.log('Getting container:', containerName);
    return database.container(containerName);
};

module.exports = { 
    getContainer,
    database,
    client
};