require('dotenv').config();


const conn_params = {
    serverNode: process.env.server_node,
    // serverNode: process.env.server_node_local,
    uid: process.env.uid,
    pwd: process.env.password,
};
let db = process.env.db

const api_params = {
    CompanyDB: db,
    UserName: process.env.service_layer_username,
    Password: process.env.service_layer_password,
}

// let db = process.env.test_db
let notIncExecutorRole= ['CEO']
module.exports = {
    notIncExecutorRole,
    conn_params,
    db,
    api_params,
    api: process.env.api,
    PORT: process.env.PORT || 3019,
    DB_URL: process.env.DB_URL,
    JWT_SECRET: process.env.JWT_SECRET || 'your_secret_key',
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5174'
};