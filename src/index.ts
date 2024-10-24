import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import FormData from 'form-data';
import express from 'express';

dotenv.config();

// Проверка переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U';
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://nudebot.railway.internal/webhook';
const PORT = process.env.PORT || 3000;

// Интерфейсы
interface ApiResponse {
    queue_time?: number;
    queue_num?: number;
    api_balance?: number;
    id_gen?: string;
    error?: string;
}

interface ProcessingResult {
    queueTime?: number;
    queueNum?: number;
    apiBalance?: number;
    idGen?: string;
}

// Инициализация базы данных
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Инициализация API клиента
const apiClient = axios.create({
    baseURL: 'https://public-api.clothoff.net',
    headers: {
        'accept': 'application/json',
        'x-api-key': CLOTHOFF_API_KEY
    }
});

// Express сервер для вебхуков
const app = express();
app.use(express.json());

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
                last_used TIMESTAMP,
                pending_task_id TEXT
            );
        `);
        console.log('База данных инициализирована успешно');
    } catch (error) {
        if (error instanceof Error) {
            console.error('Ошибка при инициализации базы данных:', error.message);
        }
        throw error;
    } finally {
        client.release();
    }
}

// Обработка изображения через API
async function processImage(imageBuffer: Buffer, userId: number): Promise<ProcessingResult> {
    const formData = new FormData();
    const id_gen = `user_${userId}_${Date.now()}`;
    
    formData.append('cloth', 'naked');
    formData.append('image', imageBuffer, {
        filename: 'image.jpg',
        contentType: 'image/jpeg'
    });
    formData.append('id_gen', id_gen);
    formData.append('webhook', WEBHOOK_URL);

    try {
        console.log('Отправка запроса в API с полями:', {
            cloth: 'naked',
            id_gen,
            webhook: WEBHOOK_URL,
            hasImage: !!imageBuffer
        });

        const response = await apiClient.post('/undress', formData, {
            headers: {
                ...formData.getHeaders(),
                'x-api-key': CLOTHOFF_API_KEY
            },
            maxBodyLength: Infinity,
            timeout: 120000
        });
        
        console.log('Ответ API:', response.data);
        
        const apiResponse: ApiResponse = response.data;
        
        if (apiResponse.error) {
            throw new Error(`API Error: ${apiResponse.error}`);
        }

        // Проверяем баланс API
        if (apiResponse.api_balance === 0) {
            throw new Error('Недостаточно баланса API');
        }
        
        // Сохраняем id_gen в базе данных
        await pool.query(
            'UPDATE users SET pending_task_id = $1 WHERE user_id = $2',
            [apiResponse.id_gen, userId]
        );
        
        return {
            queueTime: apiResponse.queue_time,
            queueNum: apiResponse.queue_num,
            apiBalance: apiResponse.api_balance,
            idGen: apiResponse.id_gen
        };
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.data) {
            console.error('API Error Response:', error.response.data);
            throw new Error(`API Error: ${error.response.data.error || 'Unknown error'}`);
        }
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
    let processingMsg;
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            return ctx.reply('У вас закончились кредиты.');
        }

        processingMsg = await ctx.reply('⏳ Обрабатываю изображение, пожалуйста, подождите...');

        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.telegram.getFile(photo.file_id);
        
        if (!file.file_path) {
            throw new Error('Не удалось получить путь к файлу');
        }

        const imageResponse = await axios.get(
            `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
            { responseType: 'arraybuffer' }
        );

        const imageBuffer = Buffer.from(imageResponse.data);

        console.log('Отправка изображения на обработку...');
        const result = await processImage(imageBuffer, userId);

        if (result.idGen) {
            await useCredit(userId);
            await ctx.reply(
                '✅ Изображение принято на обработку:\n' +
                `🕒 Время в очереди: ${result.queueTime} сек\n` +
                `📊 Позиция в очереди: ${result.queueNum}\n` +
                `🔄 ID задачи: ${result.idGen}\n\n` +
                'Результат будет отправлен, когда обработка завершится.'
            );
        } else {
            throw new Error('Не получен id_gen от API');
        }

        // Удаляем сообщение о процессе обработки
        if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }

    } catch (error) {
        let errorMessage = '❌ Произошла ошибка при обработке изображения.';
        
        if (error instanceof Error) {
            console.error('Ошибка при обработке изображения:', error.message);
            
            if (error.message.includes('Недостаточно баланса API')) {
                errorMessage = '❌ К сожалению, сервис временно недоступен из-за исчерпания баланса API. Попробуйте позже.';
            } else {
                errorMessage += `\n${error.message}`;
            }
        }

        await ctx.reply(errorMessage);

        // Пытаемся удалить сообщение о процессе обработки в случае ошибки
        if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }
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

// Обработчик вебхуков
app.post('/webhook', async (req, res) => {
    try {
        console.log('Получен webhook:', req.body);
        const { id_gen, result, error } = req.body;
        
        if (error) {
            console.error('Ошибка в webhook:', error);
            return res.status(200).json({ success: false, error });
        }

        if (result) {
            console.log('Обработка результата для задачи:', id_gen);
            
            // Находим пользователя по id_gen
            const userQuery = await pool.query(
                'SELECT user_id FROM users WHERE pending_task_id = $1',
                [id_gen]
            );
            
            if (userQuery.rows.length > 0) {
                const userId = userQuery.rows[0].user_id;
                
                try {
                    // Отправляем результат пользователю
                    const imageBuffer = Buffer.from(result, 'base64');
                    await bot.telegram.sendPhoto(userId, { source: imageBuffer });
                    await bot.telegram.sendMessage(userId, '✨ Обработка изображения завершена!');
                    
                    // Очищаем pending_task_id
                    await pool.query(
                        'UPDATE users SET pending_task_id = NULL WHERE user_id = $1',
                        [userId]
                    );
                } catch (sendError) {
                    console.error('Ошибка при отправке результата пользователю:', sendError);
                }
            } else {
                console.log('Пользователь не найден для задачи:', id_gen);
            }
        }
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Ошибка обработки webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Запуск приложения
async function start() {
    try {
        await initDB();
        console.log('База данных инициализирована');
        
        // Запуск Express сервера
        app.listen(PORT, () => {
            console.log(`Webhook сервер запущен на порту ${PORT}`);
        });

        // Запуск бота
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

start();