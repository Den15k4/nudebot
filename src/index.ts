import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Проверка наличия необходимых переменных окружения
if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN не установлен в переменных окружения');
}

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL не установлен в переменных окружения');
}

if (!process.env.CLOTHOFF_API_KEY) {
    throw new Error('CLOTHOFF_API_KEY не установлен в переменных окружения');
}

// Инициализация базы данных
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Инициализация API клиента
const apiClient = axios.create({
    baseURL: 'https://public-api.clothoff.net',
    headers: {
        'accept': 'application/json',
        'x-api-key': process.env.CLOTHOFF_API_KEY
    }
});

// Создание таблиц в базе данных
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                credits INT DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMP
            );
        `);
        console.log('База данных инициализирована успешно');
    } catch (error) {
        console.error('Ошибка при инициализации базы данных:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Обработка изображения через API
async function processImage(imageBuffer: Buffer) {
    const formData = new FormData();
    formData.append('cloth', 'naked');
    formData.append('image', imageBuffer, {
        filename: 'image.jpg',
        contentType: 'image/jpeg'
    });

    try {
        const response = await apiClient.post('/undress', formData, {
            headers: {
                ...formData.getHeaders(),
                'x-api-key': process.env.CLOTHOFF_API_KEY,
                'accept': 'application/json'
            },
            maxBodyLength: Infinity,
            timeout: 60000 // 60 секунд таймаут
        });
        return response.data;
    } catch (error) {
        console.error('Ошибка API:', error.response?.data || error.message);
        throw error;
    }
}

// Проверка кредитов пользователя
async function checkCredits(userId: number): Promise<number> {
    try {
        const result = await pool.query(
            'SELECT credits FROM users WHERE user_id = $1',
            [userId]
        );
        return result.rows[0]?.credits || 0;
    } catch (error) {
        console.error('Ошибка при проверке кредитов:', error);
        throw error;
    }
}

// Уменьшение количества кредитов
async function useCredit(userId: number) {
    try {
        await pool.query(
            'UPDATE users SET credits = credits - 1, last_used = CURRENT_TIMESTAMP WHERE user_id = $1',
            [userId]
        );
    } catch (error) {
        console.error('Ошибка при использовании кредита:', error);
        throw error;
    }
}

// Добавление нового пользователя
async function addNewUser(userId: number, username: string | undefined) {
    try {
        await pool.query(
            'INSERT INTO users (user_id, username, credits) VALUES ($1, $2, 1) ON CONFLICT (user_id) DO NOTHING',
            [userId, username || 'anonymous']
        );
    } catch (error) {
        console.error('Ошибка при добавлении пользователя:', error);
        throw error;
    }
}

// Команда /start
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;

        await addNewUser(userId, username);
        
        await ctx.reply(
            'Привет! Я бот для обработки изображений.\n' +
            'У вас есть 1 бесплатный кредит.\n' +
            'Отправьте мне изображение, и я обработаю его.\n\n' +
            'Доступные команды:\n' +
            '/credits - проверить количество кредитов'
        );
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Обработчик изображений
bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            return ctx.reply('У вас закончились кредиты.');
        }

        // Отправляем сообщение о начале обработки
        const processingMsg = await ctx.reply('⏳ Обрабатываю изображение, пожалуйста, подождите...');

        // Получаем файл фото
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.telegram.getFile(photo.file_id);
        
        if (!file.file_path) {
            throw new Error('Не удалось получить путь к файлу');
        }

        // Загружаем изображение
        const imageResponse = await axios.get(
            `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`,
            { responseType: 'arraybuffer' }
        );

        const imageBuffer = Buffer.from(imageResponse.data);

        // Обрабатываем изображение
        console.log('Отправка изображения на обработку...');
        const result = await processImage(imageBuffer);

        // Обрабатываем результат
        if (result && result.result) {
            const processedImageBuffer = Buffer.from(result.result, 'base64');
            await ctx.replyWithPhoto({ source: processedImageBuffer });
            await useCredit(userId);
            await ctx.reply('✅ Обработка завершена успешно!');
        } else if (result && result.url) {
            const processedImage = await axios.get(result.url, { responseType: 'arraybuffer' });
            await ctx.replyWithPhoto({ source: Buffer.from(processedImage.data) });
            await useCredit(userId);
            await ctx.reply('✅ Обработка завершена успешно!');
        } else {
            throw new Error('Неверный формат ответа API');
        }

        // Удаляем сообщение о обработке
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);

    } catch (error) {
        console.error('Ошибка при обработке изображения:', error);

        let errorMessage = '❌ Произошла ошибка при обработке изображения.';
        
        if (axios.isAxiosError(error)) {
            if (error.response) {
                console.error('API Error Response:', error.response.data);
                errorMessage += '\nОшибка сервера обработки. Попробуйте позже.';
            } else if (error.request) {
                errorMessage += '\nСервер не отвечает. Попробуйте позже.';
            } else {
                errorMessage += `\n${error.message}`;
            }
        }

        await ctx.reply(errorMessage);
    }
});

// Команда /credits
bot.command('credits', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const credits = await checkCredits(userId);
        await ctx.reply(`💳 У вас осталось кредитов: ${credits}`);
    } catch (error) {
        console.error('Ошибка при проверке кредитов:', error);
        await ctx.reply('Произошла ошибка при проверке кредитов. Попробуйте позже.');
    }
});

// Обработка ошибок
bot.catch((err: any, ctx) => {
    console.error('Ошибка бота:', err);
    ctx.reply('Произошла ошибка в работе бота. Пожалуйста, попробуйте позже.');
});

// Запуск бота
async function start() {
    try {
        await initDB();
        console.log('База данных инициализирована');
        await bot.launch();
        console.log('Бот запущен');
    } catch (error) {
        console.error('Ошибка при запуске приложения:', error);
        process.exit(1);
    }
}

// Graceful stop
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    pool.end();
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    pool.end();
});

// Запускаем бота
start();