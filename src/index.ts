import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Check required environment variables
if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN must be provided!');
}
if (!process.env.CLOTHOFF_API_KEY) {
    throw new Error('CLOTHOFF_API_KEY must be provided!');
}
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be provided!');
}

// Database initialization
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Create tables if not exists
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                credits INT DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } finally {
        client.release();
    }
}

// Telegram bot initialization
const bot = new Telegraf(process.env.BOT_TOKEN);

// ClothOff API configuration
const clothOffApi = axios.create({
    baseURL: 'https://api.clothoff.app/v1',
    headers: {
        'Authorization': `Bearer ${process.env.CLOTHOFF_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

// Check user credits
async function checkCredits(userId: number): Promise<number> {
    const result = await pool.query(
        'SELECT credits FROM users WHERE user_id = $1',
        [userId]
    );
    return result.rows[0]?.credits || 0;
}

// Decrease credits
async function useCredit(userId: number) {
    await pool.query(
        'UPDATE users SET credits = credits - 1 WHERE user_id = $1',
        [userId]
    );
}

// Add new user
async function addNewUser(userId: number, username: string | undefined) {
    await pool.query(
        'INSERT INTO users (user_id, username, credits) VALUES ($1, $2, 1) ON CONFLICT (user_id) DO NOTHING',
        [userId, username || 'anonymous']
    );
}

// Start command handler
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;

    await addNewUser(userId, username);
    
    await ctx.reply(
        'Привет! Я бот для обработки изображений. У вас есть 1 бесплатный кредит.\n' +
        'Отправьте мне изображение, и я обработаю его.'
    );
});

// Image handler
bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    const credits = await checkCredits(userId);

    if (credits <= 0) {
        return ctx.reply('У вас закончились кредиты.');
    }

    try {
        // Get photo file from Telegram
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.telegram.getFile(photo.file_id);
        if (!file.file_path) {
            throw new Error('Could not get file path');
        }

        const inputImage = await axios.get(
            `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`,
            { responseType: 'arraybuffer' }
        );

        // Process image with ClothOff API
        const response = await clothOffApi.post('/process', {
            image: Buffer.from(inputImage.data).toString('base64')
        });

        // Send processed image back
        if (response.data.result) {
            const processedImageBuffer = Buffer.from(response.data.result, 'base64');
            await ctx.replyWithPhoto({ source: processedImageBuffer });
            await useCredit(userId);
        } else {
            await ctx.reply('Произошла ошибка при обработке изображения.');
        }
    } catch (error) {
        console.error('Error processing image:', error);
        await ctx.reply('Произошла ошибка при обработке изображения.');
    }
});

// Credits command handler
bot.command('credits', async (ctx) => {
    const userId = ctx.from.id;
    const credits = await checkCredits(userId);
    await ctx.reply(`У вас осталось кредитов: ${credits}`);
});

// Initialize database and start bot
async function start() {
    try {
        await initDB();
        console.log('Database initialized');
        await bot.launch();
        console.log('Bot started');
    } catch (error) {
        console.error('Error starting application:', error);
        process.exit(1);
    }
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

start();