require('dotenv').config();


const conn_params = {
    serverNode: process.env.server_node,
    // serverNode: process.env.server_node_local,
    uid: process.env.uid,
    pwd: process.env.password,
};


let db = process.env.db
// let db = process.env.test_db
module.exports = {
    conn_params,
    db,
    PORT: process.env.PORT || 5000,
    DB_URL: process.env.DB_URL,
    JWT_SECRET: process.env.JWT_SECRET || 'your_secret_key',
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5174'
};
