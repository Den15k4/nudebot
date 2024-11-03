import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import FormData from 'form-data';
import express from 'express';
import multer from 'multer';
import { RukassaPayment, setupPaymentCommands, setupRukassaWebhook } from './rukassa';

dotenv.config();

// Проверка обязательных переменных окружения
function validateEnv() {
    const required = ['BOT_TOKEN', 'CLOTHOFF_API_KEY', 'DATABASE_URL', 'WEBHOOK_URL'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

validateEnv();

const BOT_TOKEN = process.env.BOT_TOKEN!;
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY!;
const BASE_WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app';
const CLOTHOFF_WEBHOOK_URL = `${BASE_WEBHOOK_URL}/webhook`;
const PORT = parseInt(process.env.PORT || '8080', 10);

// Клавиатуры
const mainKeyboard = {
    inline_keyboard: [
        [
            { text: '💫 Начать обработку', callback_data: 'start_processing' },
            { text: '💳 Купить кредиты', callback_data: 'buy_credits' }
        ],
        [
            { text: '💰 Баланс', callback_data: 'check_balance' },
            { text: '👥 Реферальная программа', callback_data: 'referral_program' }
        ]
    ]
};

const cancelKeyboard = {
    inline_keyboard: [
        [{ text: '❌ Отмена', callback_data: 'back_to_menu' }]
    ]
};

// Интерфейсы
interface ApiResponse {
    queue_time?: number;
    queue_num?: number;
    api_balance?: number;
    id_gen?: string;
    error?: string;
    status?: string;
    img_message?: string;
    img_message_2?: string;
    age?: string;
}

interface ProcessingResult {
    queueTime?: number;
    queueNum?: number;
    apiBalance?: number;
    idGen?: string;
}

interface WebhookBody {
    id_gen?: string;
    status?: string;
    img_message?: string;
    img_message_2?: string;
    result?: string;
    error?: string;
}

// Инициализация
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

const bot = new Telegraf(BOT_TOKEN);

const apiClient = axios.create({
    baseURL: 'https://public-api.clothoff.net',
    headers: {
        'accept': 'application/json',
        'x-api-key': CLOTHOFF_API_KEY
    },
    timeout: 120000
});

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

// Middleware для логирования
app.use((req, res, next) => {
    console.log('Входящий запрос:', {
        method: req.method,
        path: req.path,
        headers: req.headers,
        query: req.query,
        timestamp: new Date().toISOString()
    });
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Инициализация БД
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tablesExist = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'users'
            );
        `);

        if (!tablesExist.rows[0].exists) {
            await client.query(`
                CREATE TABLE users (
                    user_id BIGINT PRIMARY KEY,
                    username TEXT,
                    credits INT DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    last_used TIMESTAMPTZ,
                    pending_task_id TEXT,
                    referrer_id BIGINT,
                    total_referrals INT DEFAULT 0,
                    referral_earnings DECIMAL DEFAULT 0.0
                );

                CREATE INDEX idx_referrer_id ON users(referrer_id);
                CREATE INDEX idx_pending_task ON users(pending_task_id);
                CREATE INDEX idx_last_used ON users(last_used);
            `);
        }

        await client.query('COMMIT');
        console.log('База данных проверена и готова к работе');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при инициализации базы данных:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Периодическая очистка зависших задач
async function cleanupStaleTasks() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const staleResults = await client.query(`
            UPDATE users 
            SET pending_task_id = NULL 
            WHERE pending_task_id IS NOT NULL 
            AND last_used < NOW() - INTERVAL '30 minutes'
            RETURNING user_id
        `);

        for (const row of staleResults.rows) {
            await returnCredit(row.user_id);
            await bot.telegram.sendMessage(
                row.user_id,
                '⚠️ Обработка изображения не была завершена. Кредит возвращен.',
                { 
                    reply_markup: mainKeyboard
                }
            ).catch(console.error);
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при очистке зависших задач:', error);
    } finally {
        client.release();
    }
}

// Реферальная система
async function processReferral(userId: number, referrerId: number): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const referrer = await client.query(
            'SELECT user_id FROM users WHERE user_id = $1',
            [referrerId]
        );
        
        if (!referrer.rows.length) {
            throw new Error('Реферер не найден');
        }

        if (userId === referrerId) {
            throw new Error('Нельзя быть своим рефералом');
        }

        const existingUser = await client.query(
            'SELECT referrer_id FROM users WHERE user_id = $1',
            [userId]
        );
        
        if (!existingUser.rows[0]?.referrer_id) {
            const referrerChain = await client.query(`
                WITH RECURSIVE ref_chain AS (
                    SELECT user_id, referrer_id, 1 as depth
                    FROM users 
                    WHERE user_id = $1
                    UNION ALL
                    SELECT u.user_id, u.referrer_id, rc.depth + 1
                    FROM users u
                    INNER JOIN ref_chain rc ON rc.referrer_id = u.user_id
                    WHERE rc.depth < 10
                )
                SELECT user_id FROM ref_chain WHERE user_id = $2
            `, [referrerId, userId]);

            if (referrerChain.rows.length > 0) {
                throw new Error('Обнаружена циклическая реферальная связь');
            }

            await client.query(
                'UPDATE users SET referrer_id = $1 WHERE user_id = $2',
                [referrerId, userId]
            );
            
            await client.query(
                'UPDATE users SET total_referrals = total_referrals + 1 WHERE user_id = $1',
                [referrerId]
            );

            await bot.telegram.sendMessage(
                referrerId,
                '🎉 У вас новый реферал! Вы будете получать 50% от суммы его платежей.'
            ).catch(console.error);
        }
        
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при обработке реферала:', error);
    } finally {
        client.release();
    }
}

// Базовые функции работы с пользователями
async function getUser(userId: number) {
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE user_id = $1',
            [userId]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Ошибка при получении пользователя:', error);
        throw new Error('Не удалось получить данные пользователя');
    }
}

async function checkCredits(userId: number): Promise<number> {
    try {
        const user = await getUser(userId);
        return user?.credits || 0;
    } catch (error) {
        console.error('Ошибка при проверке кредитов:', error);
        throw new Error('Не удалось проверить баланс кредитов');
    }
}

async function useCredit(userId: number): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const result = await client.query(
            'UPDATE users SET credits = credits - 1, last_used = CURRENT_TIMESTAMP WHERE user_id = $1 AND credits > 0 RETURNING credits',
            [userId]
        );

        if (result.rows.length === 0) {
            throw new Error('Недостаточно кредитов');
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при использовании кредита:', error);
        throw error;
    } finally {
        client.release();
    }
}
async function returnCredit(userId: number): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await client.query(
            'UPDATE users SET credits = credits + 1 WHERE user_id = $1',
            [userId]
        );

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при возврате кредита:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function addNewUser(userId: number, username: string | undefined): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await client.query(
            'INSERT INTO users (user_id, username, credits) VALUES ($1, $2, 0) ON CONFLICT (user_id) DO NOTHING',
            [userId, username || 'anonymous']
        );

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при добавлении пользователя:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Обработка изображений
async function isAdultContent(): Promise<boolean> {
    return true; // Заглушка
}

async function processImage(imageBuffer: Buffer, userId: number): Promise<ProcessingResult> {
    const formData = new FormData();
    const id_gen = `user_${userId}_${Date.now()}`;
    
    formData.append('cloth', 'naked');
    formData.append('image', imageBuffer, {
        filename: 'image.jpg',
        contentType: 'image/jpeg'
    });
    formData.append('id_gen', id_gen);
    formData.append('webhook', CLOTHOFF_WEBHOOK_URL);

    try {
        console.log('Отправка запроса в API:', {
            id_gen,
            webhook: CLOTHOFF_WEBHOOK_URL,
            timestamp: new Date().toISOString()
        });

        const response = await apiClient.post('/undress', formData, {
            headers: {
                ...formData.getHeaders(),
                'x-api-key': CLOTHOFF_API_KEY
            },
            maxBodyLength: Infinity
        });
        
        console.log('Ответ API:', response.data);
        
        const apiResponse: ApiResponse = response.data;
        
        if (apiResponse.error) {
            if (apiResponse.error === 'Insufficient balance') {
                throw new Error('INSUFFICIENT_BALANCE');
            }
            throw new Error(`API Error: ${apiResponse.error}`);
        }
        
        await pool.query(
            'UPDATE users SET pending_task_id = $1 WHERE user_id = $2',
            [id_gen, userId]
        );
        
        return {
            queueTime: apiResponse.queue_time,
            queueNum: apiResponse.queue_num,
            apiBalance: apiResponse.api_balance,
            idGen: id_gen
        };
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('API Error Response:', error.response?.data);
            if (error.response?.data?.error === 'Insufficient balance') {
                throw new Error('INSUFFICIENT_BALANCE');
            }
            throw new Error(`API Error: ${error.response?.data?.error || 'Unknown error'}`);
        }
        throw error;
    }
}

// Команды бота
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const args = ctx.message.text.split(' ');
        
        await addNewUser(userId, username);
        
        if (args[1] && args[1].startsWith('ref')) {
            const referrerId = parseInt(args[1].substring(3));
            if (referrerId && referrerId !== userId) {
                try {
                    await processReferral(userId, referrerId);
                } catch (error) {
                    console.error('Ошибка обработки реферала:', error);
                }
            }
        }
        
        await ctx.replyWithPhoto(
            { source: './assets/welcome.jpg' },
            {
                caption: 'Добро пожаловать! 👋\n\n' +
                        'Я помогу вам обработать изображения с помощью нейросети.\n' +
                        'Для начала работы купите кредиты.\n\n' +
                        'Выберите действие:',
                reply_markup: mainKeyboard
            }
        );
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Обработчики действий
bot.action('start_processing', async (ctx) => {
    try {
        if (!ctx.from) {
            await ctx.answerCbQuery('Ошибка: пользователь не найден');
            return;
        }
        const userId = ctx.from.id;
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            await ctx.answerCbQuery('У вас недостаточно кредитов!');
            await ctx.editMessageCaption(
                '❌ У вас нет кредитов\n\n' +
                'Пожалуйста, пополните баланс для начала работы.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 Купить кредиты', callback_data: 'buy_credits' }],
                            [{ text: '↩️ Вернуться в меню', callback_data: 'back_to_menu' }]
                        ]
                    }
                }
            );
            return;
        }

        await ctx.answerCbQuery();
        await ctx.editMessageCaption(
            '📸 Отправьте мне фотографию для обработки\n\n' +
            '⚠️ Важные правила:\n' +
            '1. Изображение должно содержать только людей старше 18 лет\n' +
            '2. Убедитесь, что на фото чётко видно лицо\n' +
            '3. Изображение должно быть хорошего качества',
            { reply_markup: cancelKeyboard }
        );
    } catch (error) {
        console.error('Ошибка при начале обработки:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

bot.action('check_balance', async (ctx) => {
    try {
        if (!ctx.from) {
            await ctx.answerCbQuery('Ошибка: пользователь не найден');
            return;
        }

        const userId = ctx.from.id;
        const credits = await checkCredits(userId);

        await ctx.answerCbQuery();
        await ctx.editMessageCaption(
            `💰 Ваш текущий баланс: ${credits} кредитов\n\n` +
            '1 кредит = 1 обработка изображения',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Купить кредиты', callback_data: 'buy_credits' }],
                        [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при проверке баланса:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

bot.action('referral_program', async (ctx) => {
    try {
        if (!ctx.from) {
            await ctx.answerCbQuery('Ошибка: пользователь не найден');
            return;
        }

        const userId = ctx.from.id;
        const user = await pool.query(
            'SELECT total_referrals, referral_earnings FROM users WHERE user_id = $1',
            [userId]
        );

        const botInfo = await bot.telegram.getMe();
        const referralLink = `https://t.me/${botInfo.username}?start=ref${userId}`;
        const totalReferrals = user.rows[0]?.total_referrals || 0;
        const earnings = user.rows[0]?.referral_earnings || 0;

        await ctx.answerCbQuery();
        await ctx.editMessageCaption(
            '👥 Реферальная программа\n\n' +
            '🔗 Ваша реферальная ссылка:\n' +
            `${referralLink}\n\n` +
            '📊 Статистика:\n' +
            `👤 Рефералов: ${totalReferrals}\n` +
            `💰 Заработано: ${earnings.toFixed(2)} RUB\n\n` +
            '💡 Получайте 50% от каждого платежа ваших рефералов!',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '♻️ Обновить статистику', callback_data: 'refresh_referrals' }],
                        [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при показе реферальной программы:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

bot.action('refresh_referrals', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        if (!ctx.from) {
            return;
        }

        const userId = ctx.from.id;
        const user = await pool.query(
            'SELECT total_referrals, referral_earnings FROM users WHERE user_id = $1',
            [userId]
        );

        const botInfo = await bot.telegram.getMe();
        const referralLink = `https://t.me/${botInfo.username}?start=ref${userId}`;
        const totalReferrals = user.rows[0]?.total_referrals || 0;
        const earnings = user.rows[0]?.referral_earnings || 0;

        await ctx.editMessageCaption(
            '👥 Реферальная программа\n\n' +
            '🔗 Ваша реферальная ссылка:\n' +
            `${referralLink}\n\n` +
            '📊 Статистика:\n' +
            `👤 Рефералов: ${totalReferrals}\n` +
            `💰 Заработано: ${earnings.toFixed(2)} RUB\n\n` +
            '💡 Получайте 50% от каждого платежа ваших рефералов!',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '♻️ Обновить статистику', callback_data: 'refresh_referrals' }],
                        [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при обновлении статистики:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

bot.action('back_to_menu', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await ctx.editMessageCaption(
            'Выберите действие:',
            { reply_markup: mainKeyboard }
        );
    } catch (error) {
        console.error('Ошибка при возврате в меню:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});
// Обработка фотографий
bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    let processingMsg;
    let creditUsed = false;
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            return ctx.reply(
                '❌ У вас нет кредитов\n\n' +
                'Пожалуйста, пополните баланс для начала работы.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 Купить кредиты', callback_data: 'buy_credits' }],
                            [{ text: '↩️ Вернуться в меню', callback_data: 'back_to_menu' }]
                        ]
                    }
                }
            );
        }

        // Проверяем, нет ли уже активной задачи
        const user = await getUser(userId);
        if (user?.pending_task_id) {
            return ctx.reply(
                '⚠️ У вас уже есть активная задача в обработке.\n' +
                'Пожалуйста, дождитесь её завершения.',
                { reply_markup: mainKeyboard }
            );
        }

        processingMsg = await ctx.reply('⏳ Начинаю обработку изображения...');

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

        if (!await isAdultContent()) {
            throw new Error('AGE_RESTRICTION');
        }

        console.log('Отправка изображения на обработку...');
        const result = await processImage(imageBuffer, userId);

        if (result.idGen) {
            await useCredit(userId);
            creditUsed = true;
            await ctx.reply(
                '✅ Изображение принято в обработку:\n\n' +
                `⏱ Время в очереди: ${result.queueTime} сек\n` +
                `📊 Позиция в очереди: ${result.queueNum}\n` +
                `🔄 ID задачи: ${result.idGen}\n\n` +
                '🔍 Результат будет отправлен, когда обработка завершится.',
                { reply_markup: mainKeyboard }
            );
        }

    } catch (error) {
        console.error('Ошибка при обработке изображения:', error);
        
        if (creditUsed) {
            try {
                await returnCredit(userId);
                await pool.query(
                    'UPDATE users SET pending_task_id = NULL WHERE user_id = $1',
                    [userId]
                );
            } catch (returnError) {
                console.error('Ошибка при возврате кредита:', returnError);
            }
        }

        let errorMessage = '❌ Произошла ошибка при обработке изображения.';
        
        if (error instanceof Error) {
            if (error.message === 'AGE_RESTRICTION') {
                errorMessage = '🔞 Обработка запрещена:\n\n' +
                    'Изображение не прошло проверку возрастных ограничений. ' +
                    'Пожалуйста, убедитесь, что на фото только люди старше 18 лет.';
            } else if (error.message === 'INSUFFICIENT_BALANCE') {
                errorMessage = '⚠️ Сервис временно недоступен\n\n' +
                    'К сожалению, у сервиса закончился баланс API. ' +
                    'Пожалуйста, попробуйте позже или свяжитесь с администратором бота.\n\n' +
                    'Ваши кредиты сохранены и будут доступны позже.';
            } else {
                errorMessage += `\n${error.message}`;
            }
        }

        await ctx.reply(errorMessage, { reply_markup: mainKeyboard });
    } finally {
        if (processingMsg) {
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            } catch (deleteError) {
                console.error('Ошибка при удалении сообщения:', deleteError);
            }
        }
    }
});

// Webhook обработчик для ClothOff
app.post(['/webhook'], upload.any(), async (req, res) => {
    try {
        console.log('Получен webhook от ClothOff:', {
            path: req.path,
            timestamp: new Date().toISOString()
        });
        console.log('Headers:', req.headers);
        console.log('Body:', req.body);
        console.log('Files:', req.files);

        const body = req.body as WebhookBody;
        const files = req.files as Express.Multer.File[] || [];

        if (!body.id_gen) {
            throw new Error('Missing id_gen in webhook');
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const userQuery = await client.query(
                'SELECT user_id FROM users WHERE pending_task_id = $1',
                [body.id_gen]
            );

            if (userQuery.rows.length === 0) {
                throw new Error(`User not found for task ${body.id_gen}`);
            }

            const userId = userQuery.rows[0].user_id;

            if (body.status === '500' || body.img_message || body.img_message_2) {
                console.log(`Ошибка обработки изображения: ${body.img_message || body.img_message_2}`);
                
                let errorMessage = '❌ Не удалось обработать изображение:\n\n';
                if (body.img_message?.includes('Age is too young') || body.img_message_2?.includes('Age is too young')) {
                    errorMessage += '🔞 На изображении обнаружен человек младше 18 лет.\n' +
                                  'Обработка таких изображений запрещена.';
                } else {
                    errorMessage += body.img_message || body.img_message_2 || 'Неизвестная ошибка';
                }

                await returnCredit(userId);
                await client.query(
                    'UPDATE users SET pending_task_id = NULL WHERE user_id = $1',
                    [userId]
                );

                await bot.telegram.sendMessage(userId, errorMessage, { reply_markup: mainKeyboard });
                await bot.telegram.sendMessage(
                    userId,
                    '💳 Кредит был возвращен из-за ошибки обработки.',
                    { reply_markup: mainKeyboard }
                );
            } else {
                let imageBuffer: Buffer | undefined;
                if (body.result) {
                    imageBuffer = Buffer.from(body.result, 'base64');
                } else if (files.length > 0) {
                    imageBuffer = files[0].buffer;
                }

                if (imageBuffer) {
                    await bot.telegram.sendPhoto(
                        userId,
                        { source: imageBuffer },
                        {
                            caption: '✨ Обработка изображения завершена!\n' +
                                   'Чтобы обработать новое фото, нажмите кнопку 💫 Начать обработку',
                            reply_markup: mainKeyboard
                        }
                    );
                } else {
                    throw new Error('No image data in webhook response');
                }

                await client.query(
                    'UPDATE users SET pending_task_id = NULL WHERE user_id = $1',
                    [userId]
                );
            }

            await client.query('COMMIT');
            res.status(200).json({ success: true });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Ошибка обработки webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Запуск приложения
// Запуск приложения
async function start() {
    try {
        await initDB();
        console.log('База данных инициализирована');

        const rukassaPayment = new RukassaPayment(pool, bot, {
            processReferralPayment: async (userId: number, amount: number) => {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    
                    const referrerResult = await client.query(
                        'SELECT referrer_id FROM users WHERE user_id = $1',
                        [userId]
                    );
                    
                    if (referrerResult.rows[0]?.referrer_id) {
                        const referrerId = referrerResult.rows[0].referrer_id;
                        const referralBonus = amount * 0.5;
                        
                        await client.query(
                            'UPDATE users SET referral_earnings = referral_earnings + $1 WHERE user_id = $2',
                            [referralBonus, referrerId]
                        );
                        
                        await bot.telegram.sendMessage(
                            referrerId,
                            `🎁 Вы получили реферальный бонус ${referralBonus.toFixed(2)} RUB от оплаты вашего реферала!`
                        );
                    }
                    
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK');
                    console.error('Ошибка при обработке реферального платежа:', error);
                } finally {
                    client.release();
                }
            }
        });

        await rukassaPayment.initPaymentsTable();
        console.log('Таблица платежей инициализирована');

        setupPaymentCommands(bot, pool);
        setupRukassaWebhook(app, rukassaPayment);
        console.log('Платежная система инициализирована');
        
        // Запускаем периодическую очистку зависших задач
        setInterval(cleanupStaleTasks, 5 * 60 * 1000); // Каждые 5 минут

        const WEBHOOK_PATH = '/telegram-webhook';
        const WEBHOOK_URL = `${BASE_WEBHOOK_URL}${WEBHOOK_PATH}`;

        // Сначала удаляем существующий webhook
        await bot.telegram.deleteWebhook();
        
        // Настраиваем webhook для Telegram
        app.use(bot.webhookCallback(WEBHOOK_PATH));

        // Запускаем сервер
        await new Promise<void>((resolve) => {
            app.listen(PORT, '0.0.0.0', () => {
                console.log(`Webhook сервер запущен на порту ${PORT}`);
                console.log(`ClothOff webhook URL: ${CLOTHOFF_WEBHOOK_URL}`);
                console.log(`Base webhook URL: ${BASE_WEBHOOK_URL}`);
                resolve();
            });
        });

        // Устанавливаем новый webhook
        await bot.telegram.setWebhook(WEBHOOK_URL);
        console.log('Telegram webhook установлен:', WEBHOOK_URL);

    } catch (error) {
        console.error('Ошибка при запуске приложения:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.once('SIGINT', async () => {
    console.log('Получен сигнал SIGINT');
    await bot.telegram.deleteWebhook();
    bot.stop('SIGINT');
    await pool.end();
});

process.once('SIGTERM', async () => {
    console.log('Получен сигнал SIGTERM');
    await bot.telegram.deleteWebhook();
    bot.stop('SIGTERM');
    await pool.end();
});

// Запускаем приложение
start();