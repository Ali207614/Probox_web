'use strict';

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('[BOT] BOT_TOKEN topilmadi! .env faylga qo\'shing.');
    process.exit(1);
}

// polling: false — faqat xabar jo'natish uchun ishlatamiz
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

module.exports = bot;