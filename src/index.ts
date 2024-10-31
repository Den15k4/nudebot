import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { ParseMode } from 'telegraf/typings/core/types/typegram';
import axios from 'axios';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import FormData from 'form-data';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { scheduleJob, Job } from 'node-schedule';
import { RukassaPayment, setupPaymentCommands, setupRukassaWebhook } from './rukassa';

dotenv.config();

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U';
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app/webhook';
const PORT = parseInt(process.env.PORT || '8080', 10);
const RULES_URL = 'https://telegra.ph/Pravila-ispolzovaniya-bota-03-27';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

// Константы для меню
const MENU_ACTIONS = {
    BUY_CREDITS: '💳 Купить кредиты',
    CHECK_BALANCE: '💰 Баланс',
    INFORMATION: 'ℹ️ Информация',
    HELP: '❓ Помощь',
    BACK: '◀️ Назад',
    ACCEPT_RULES: '✅ Принимаю правила',
    VIEW_RULES: '📜 Правила использования'
} as const;

const ADMIN_ACTIONS = {
    BROADCAST: '📢 Рассылка',
    SCHEDULE: '🕒 Отложенная рассылка',
    STATS: '📊 Статистика',
    CANCEL_BROADCAST: '❌ Отменить рассылку'
} as const;

const IMAGES = {
    WELCOME: path.join(__dirname, '../assets/welcome.jpg'),
    BALANCE: path.join(__dirname, '../assets/balance.jpg'),
    PAYMENT: path.join(__dirname, '../assets/payment.jpg'),
    PAYMENT_PROCESS: path.join(__dirname, '../assets/payment_process.jpg'),
    REFERRAL: path.join(__dirname, '../assets/referral.jpg')
} as const;

// Интерфейсы
interface MessageOptions {
    reply_markup?: any;
    parse_mode?: ParseMode;
    [key: string]: any;
}

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

interface ScheduledBroadcast {
    id: string;
    date: Date;
    message: string;
    image?: string;
    keyboard?: any;
}

// Состояния
const scheduledBroadcasts = new Map<string, Job>();
const awaitingBroadcastMessage = new Set<number>();
const awaitingBroadcastDate = new Set<number>();
const broadcastImage: { [key: string]: string } = {};

// Функции для клавиатур
function getMainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [MENU_ACTIONS.BUY_CREDITS, MENU_ACTIONS.CHECK_BALANCE],
                [MENU_ACTIONS.INFORMATION, MENU_ACTIONS.HELP],
                [MENU_ACTIONS.BACK]
            ],
            resize_keyboard: true
        }
    };
}

function getInitialKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [MENU_ACTIONS.VIEW_RULES],
                [MENU_ACTIONS.ACCEPT_RULES],
                [MENU_ACTIONS.HELP]
            ],
            resize_keyboard: true
        }
    };
}

function getAdminKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [ADMIN_ACTIONS.BROADCAST, ADMIN_ACTIONS.SCHEDULE],
                [ADMIN_ACTIONS.STATS, ADMIN_ACTIONS.CANCEL_BROADCAST],
                [MENU_ACTIONS.BACK]
            ],
            resize_keyboard: true
        }
    };
}

// Инициализация
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const bot = new Telegraf(BOT_TOKEN);

const apiClient = axios.create({
    baseURL: 'https://public-api.clothoff.net',
    headers: {
        'accept': 'application/json',
        'x-api-key': CLOTHOFF_API_KEY
    }
});

// Express и multer
const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

app.use((req, res, next) => {
    console.log('Входящий запрос:', {
        method: req.method,
        path: req.path,
        headers: req.headers
    });
    next();
});

app.use(express.json());

// Вспомогательные функции для отправки сообщений
async function sendMessageWithImage(
    ctx: any, 
    imagePath: string, 
    text: string, 
    options?: { reply_markup?: any }
) {
    try {
        const image = await fs.readFile(imagePath);
        await ctx.replyWithPhoto(
            { source: image },
            {
                caption: text,
                parse_mode: 'HTML' as ParseMode,
                ...(options || {})
            }
        );
    } catch (error) {
        console.error('Ошибка при отправке сообщения с изображением:', error);
        if (options?.reply_markup) {
            await ctx.reply(text, {
                parse_mode: 'HTML' as ParseMode,
                ...options
            });
        } else {
            await ctx.reply(text, { parse_mode: 'HTML' as ParseMode });
        }
    }
}

async function sendMessageWithImageBot(
    bot: Telegraf,
    userId: number,
    imagePath: string,
    text: string,
    options?: { reply_markup?: any }
) {
    try {
        const image = await fs.readFile(imagePath);
        await bot.telegram.sendPhoto(
            userId,
            { source: image },
            {
                caption: text,
                parse_mode: 'HTML' as ParseMode,
                ...(options || {})
            }
        );
    } catch (error) {
        console.error('Ошибка при отправке сообщения с изображением:', error);
        if (options?.reply_markup) {
            await bot.telegram.sendMessage(userId, text, {
                parse_mode: 'HTML' as ParseMode,
                ...options
            });
        } else {
            await bot.telegram.sendMessage(userId, text, { parse_mode: 'HTML' as ParseMode });
        }
    }
}

// Функции для работы с базой данных
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tableExists = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'users'
            );
        `);

        if (!tableExists.rows[0].exists) {
            await client.query(`
                CREATE TABLE users (
                    user_id BIGINT PRIMARY KEY,
                    username TEXT,
                    credits INT DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    last_used TIMESTAMPTZ,
                    pending_task_id TEXT,
                    accepted_rules BOOLEAN DEFAULT FALSE
                );
            `);
            console.log('Создана новая таблица users');
        }

        await client.query('COMMIT');
        console.log('База данных успешно инициализирована');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при инициализации базы данных:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function getAllUsers(): Promise<{user_id: number}[]> {
    try {
        const result = await pool.query('SELECT user_id FROM users WHERE accepted_rules = TRUE');
        return result.rows;
    } catch (error) {
        console.error('Ошибка при получении списка пользователей:', error);
        return [];
    }
}

async function getActiveUsers(days: number = 7): Promise<{user_id: number}[]> {
    try {
        const result = await pool.query(`
            SELECT DISTINCT user_id 
            FROM users 
            WHERE last_used >= NOW() - INTERVAL '${days} days'
            AND accepted_rules = TRUE
        `);
        return result.rows;
    } catch (error) {
        console.error('Ошибка при получении списка активных пользователей:', error);
        return [];
    }
}

async function isAdmin(userId: string): Promise<boolean> {
    return ADMIN_IDS.includes(userId);
}

async function hasAcceptedRules(userId: number): Promise<boolean> {
    try {
        const result = await pool.query(
            'SELECT accepted_rules FROM users WHERE user_id = $1',
            [userId]
        );
        return result.rows[0]?.accepted_rules || false;
    } catch (error) {
        console.error('Ошибка при проверке принятия правил:', error);
        return false;
    }
}

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

async function useCredit(userId: number): Promise<void> {
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

async function returnCredit(userId: number): Promise<void> {
    try {
        await pool.query(
            'UPDATE users SET credits = credits + 1 WHERE user_id = $1',
            [userId]
        );
    } catch (error) {
        console.error('Ошибка при возврате кредита:', error);
        throw error;
    }
}

async function addNewUser(userId: number, username: string | undefined): Promise<void> {
    try {
        await pool.query(
            'INSERT INTO users (user_id, username, credits, accepted_rules) VALUES ($1, $2, 0, FALSE) ON CONFLICT (user_id) DO NOTHING',
            [userId, username || 'anonymous']
        );
    } catch (error) {
        console.error('Ошибка при добавлении пользователя:', error);
        throw error;
    }
}

// Функции для обработки изображений
async function isAdultContent(): Promise<boolean> {
    try {
        return true;
    } catch (error) {
        console.error('Ошибка при проверке содержимого:', error);
        return false;
    }
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
    formData.append('webhook', WEBHOOK_URL);

    try {
        const response = await apiClient.post('/undress', formData, {
            headers: {
                ...formData.getHeaders(),
                'x-api-key': CLOTHOFF_API_KEY
            },
            maxBodyLength: Infinity,
            timeout: 120000
        });
        
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
        if (axios.isAxiosError(error) && error.response?.data) {
            if (error.response.data.error === 'Insufficient balance') {
                throw new Error('INSUFFICIENT_BALANCE');
            }
            throw new Error(`API Error: ${error.response.data.error || 'Unknown error'}`);
        }
        throw error;
    }
}
// Middleware для проверки правил
async function requireAcceptedRules(ctx: any, next: () => Promise<void>) {
    try {
        const userId = ctx.from?.id.toString();
        
        if (await isAdmin(userId)) {
            return next();
        }

        if (
            ctx.message?.text === '/start' || 
            ctx.message?.text === MENU_ACTIONS.BACK || 
            ctx.message?.text === MENU_ACTIONS.VIEW_RULES ||
            ctx.message?.text === MENU_ACTIONS.ACCEPT_RULES
        ) {
            return next();
        }

        if (!ctx.from?.id) {
            return;
        }

        const accepted = await hasAcceptedRules(ctx.from.id);
        if (!accepted) {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '⚠️ Для использования бота необходимо принять правила.\n' +
                'Используйте команду /start для просмотра правил.',
                getInitialKeyboard()
            );
            return;
        }

        return next();
    } catch (error) {
        console.error('Ошибка в middleware проверки правил:', error);
        return next();
    }
}

// Применяем middleware
bot.use(requireAcceptedRules);

// Функции для рассылок
async function broadcastMessage(
    bot: Telegraf,
    message: string,
    image?: string,
    options?: { reply_markup?: any }
): Promise<{ success: number; failed: number }> {
    const users = await getAllUsers();
    let successCount = 0;
    let failedCount = 0;

    for (const user of users) {
        try {
            if (image) {
                await sendMessageWithImageBot(bot, user.user_id, image, message, options);
            } else {
                await bot.telegram.sendMessage(user.user_id, message, {
                    parse_mode: 'HTML' as ParseMode,
                    ...(options || {})
                });
            }
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
            console.error(`Ошибка отправки сообщения пользователю ${user.user_id}:`, error);
            failedCount++;
        }
    }

    return { success: successCount, failed: failedCount };
}

function scheduleBroadcast(
    bot: Telegraf,
    date: Date,
    message: string,
    image?: string,
    options?: { reply_markup?: any }
): string {
    const broadcastId = `broadcast_${Date.now()}`;
    
    const job = scheduleJob(date, async () => {
        try {
            await broadcastMessage(bot, message, image, options);
            scheduledBroadcasts.delete(broadcastId);
            
            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(
                        adminId,
                        `✅ Отложенная рассылка выполнена:\n${message.substring(0, 100)}...`,
                        { parse_mode: 'HTML' as ParseMode }
                    );
                } catch (error) {
                    console.error('Ошибка уведомления админа:', error);
                }
            }
        } catch (error) {
            console.error('Ошибка выполнения отложенной рассылки:', error);
        }
    });

    scheduledBroadcasts.set(broadcastId, job);
    return broadcastId;
}

// Основные команды бота
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;

        await addNewUser(userId, username);
        
        const accepted = await hasAcceptedRules(userId);
        if (!accepted) {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '👋 Добро пожаловать!\n\n' +
                '🤖 Я бот для обработки изображений с использованием нейросети.\n\n' +
                '⚠️ Перед началом работы, пожалуйста:\n' +
                '1. Ознакомьтесь с правилами использования бота\n' +
                '2. Подтвердите своё согласие с правилами\n\n' +
                '❗️ Важно: использование бота возможно только после принятия правил.',
                getInitialKeyboard()
            );
        } else {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '🤖 С возвращением!\n\n' +
                'Для обработки изображений необходимы кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Используйте кнопки меню для навигации:',
                getMainKeyboard()
            );
        }
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Админские команды
bot.command('admin', async (ctx) => {
    if (!await isAdmin(ctx.from.id.toString())) {
        return;
    }

    await ctx.reply(
        '👨‍💼 Панель администратора\n\n' +
        'Выберите действие:',
        getAdminKeyboard()
    );
});

// Обработчики меню
bot.hears(MENU_ACTIONS.VIEW_RULES, async (ctx) => {
    await sendMessageWithImage(
        ctx,
        IMAGES.WELCOME,
        '📜 <b>Правила использования бота:</b>\n\n' +
        '1. Бот предназначен только для лиц старше 18 лет\n' +
        '2. Запрещено использование изображений несовершеннолетних\n' +
        '3. Запрещено использование изображений, содержащих насилие\n' +
        '4. Пользователь несет ответственность за загружаемый контент\n' +
        '5. Администрация бота не хранит обработанные изображения\n\n' +
        '❗️ Нарушение правил приведет к блокировке без возврата средств',
        getInitialKeyboard()
    );
});

bot.hears(MENU_ACTIONS.ACCEPT_RULES, async (ctx) => {
    try {
        const userId = ctx.from?.id;
        if (!userId) return;

        await pool.query(
            'UPDATE users SET accepted_rules = TRUE WHERE user_id = $1',
            [userId]
        );

        await sendMessageWithImage(
            ctx,
            IMAGES.WELCOME,
            '✅ Спасибо за принятие правил!\n\n' +
            '🤖 Теперь вы можете использовать бота.\n\n' +
            'Для начала работы необходимо приобрести кредиты:\n' +
            '1 кредит = 1 обработка изображения\n\n' +
            'Используйте кнопки меню для навигации:',
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при принятии правил:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
});

bot.hears(MENU_ACTIONS.BUY_CREDITS, async (ctx) => {
    const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💳 Visa/MC (RUB)', 'currency_RUB')],
        [Markup.button.callback('💳 Visa/MC (KZT)', 'currency_KZT')],
        [Markup.button.callback('💳 Visa/MC (UZS)', 'currency_UZS')],
        [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')],
        [Markup.button.callback('◀️ Назад', 'back_to_menu')]
    ]);

    await sendMessageWithImage(
        ctx,
        IMAGES.PAYMENT,
        '💳 Выберите способ оплаты:',
        { reply_markup: inlineKeyboard }
    );
});
bot.hears(MENU_ACTIONS.CHECK_BALANCE, async (ctx) => {
    try {
        const userId = ctx.from.id;
        const credits = await checkCredits(userId);
        await sendMessageWithImage(
            ctx,
            IMAGES.BALANCE,
            `💳 У вас ${credits} кредитов`,
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при проверке кредитов:', error);
        await ctx.reply('Произошла ошибка при проверке кредитов. Попробуйте позже.');
    }
});

bot.hears(MENU_ACTIONS.INFORMATION, async (ctx) => {
    await sendMessageWithImage(
        ctx,
        IMAGES.WELCOME,
        'ℹ️ <b>Информация о боте:</b>\n\n' +
        '🤖 Этот бот использует нейросеть для обработки изображений.\n\n' +
        '💡 Как использовать:\n' +
        '1. Купите кредиты\n' +
        '2. Отправьте фотографию\n' +
        '3. Дождитесь результата\n\n' +
        '⚠️ Требования к фото:\n' +
        '- Хорошее качество\n' +
        '- Четкое изображение лица\n' +
        '- Только совершеннолетние\n\n' +
        '❓ Нужна помощь? Используйте команду /help',
        getMainKeyboard()
    );
});

bot.hears(MENU_ACTIONS.HELP, async (ctx) => {
    await sendMessageWithImage(
        ctx,
        IMAGES.WELCOME,
        '❓ <b>Помощь:</b>\n\n' +
        'Доступные команды:\n' +
        '/start - Перезапустить бота\n' +
        '/buy - Купить кредиты\n' +
        '/credits - Проверить баланс\n\n' +
        'При возникновении проблем обращайтесь в поддержку: @support',
        getMainKeyboard()
    );
});

bot.hears(MENU_ACTIONS.BACK, async (ctx) => {
    try {
        const accepted = await hasAcceptedRules(ctx.from.id);
        if (!accepted) {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '👋 Добро пожаловать!\n\n' +
                '🤖 Я бот для обработки изображений с использованием нейросети.\n\n' +
                '⚠️ Перед началом работы, пожалуйста:\n' +
                '1. Ознакомьтесь с правилами использования бота\n' +
                '2. Подтвердите своё согласие с правилами\n\n' +
                '❗️ Важно: использование бота возможно только после принятия правил.',
                getInitialKeyboard()
            );
        } else {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '🤖 Главное меню\n\n' +
                'Для обработки изображений необходимы кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Используйте кнопки меню для навигации:',
                getMainKeyboard()
            );
        }
    } catch (error) {
        console.error('Ошибка при возврате в главное меню:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка действий с inline клавиатурой
bot.action('back_to_menu', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await sendMessageWithImage(
            ctx,
            IMAGES.WELCOME,
            '🤖 Главное меню\n\n' +
            'Для обработки изображений необходимы кредиты:\n' +
            '1 кредит = 1 обработка изображения\n\n' +
            'Используйте кнопки меню для навигации:',
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при возврате в меню:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
});

// Обработчики админских действий
bot.hears(ADMIN_ACTIONS.BROADCAST, async (ctx) => {
    if (!await isAdmin(ctx.from.id.toString())) return;

    awaitingBroadcastMessage.add(ctx.from.id);
    await ctx.reply(
        '📢 Выберите тип рассылки:\n\n' +
        '1. Отправьте текст для обычной рассылки\n' +
        '2. Отправьте изображение с текстом для рассылки с картинкой\n\n' +
        'Для отмены нажмите "Отменить рассылку"',
        {
            reply_markup: {
                keyboard: [
                    [ADMIN_ACTIONS.CANCEL_BROADCAST],
                    [MENU_ACTIONS.BACK]
                ],
                resize_keyboard: true
            }
        }
    );
});

bot.hears(ADMIN_ACTIONS.CANCEL_BROADCAST, async (ctx) => {
    if (!await isAdmin(ctx.from.id.toString())) return;

    awaitingBroadcastMessage.delete(ctx.from.id);
    awaitingBroadcastDate.delete(ctx.from.id);
    delete broadcastImage[ctx.from.id];

    await ctx.reply(
        '❌ Рассылка отменена',
        getAdminKeyboard()
    );
});

// Обработка отложенных рассылок
bot.hears(ADMIN_ACTIONS.SCHEDULE, async (ctx) => {
    if (!await isAdmin(ctx.from.id.toString())) return;

    awaitingBroadcastDate.add(ctx.from.id);
    await ctx.reply(
        '🕒 Отправьте дату и время рассылки в формате:\n' +
        'DD.MM.YYYY HH:mm\n\n' +
        'Например: 25.12.2024 15:30\n\n' +
        'Для отмены нажмите "Отменить рассылку"',
        {
            reply_markup: {
                keyboard: [
                    [ADMIN_ACTIONS.CANCEL_BROADCAST],
                    [MENU_ACTIONS.BACK]
                ],
                resize_keyboard: true
            }
        }
    );
});

// Обработка фотографий
bot.on(message('photo'), async (ctx) => {
    // Проверяем, является ли это частью рассылки от админа
    if (await isAdmin(ctx.from.id.toString()) && awaitingBroadcastMessage.has(ctx.from.id)) {
        try {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            const file = await ctx.telegram.getFile(photo.file_id);
            
            if (!file.file_path) {
                throw new Error('Не удалось получить путь к файлу');
            }

            const response = await axios.get(
                `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
                { responseType: 'arraybuffer' }
            );

            const tempPath = path.join(__dirname, `../temp_broadcast_${ctx.from.id}.jpg`);
            await fs.writeFile(tempPath, Buffer.from(response.data));
            
            broadcastImage[ctx.from.id] = tempPath;

            if (ctx.message.caption) {
                const result = await broadcastMessage(
                    bot,
                    ctx.message.caption,
                    tempPath
                );

                await ctx.reply(
                    `✅ Рассылка с изображением завершена!\n\n` +
                    `Успешно: ${result.success}\n` +
                    `Ошибок: ${result.failed}`,
                    getAdminKeyboard()
                );

                awaitingBroadcastMessage.delete(ctx.from.id);
                delete broadcastImage[ctx.from.id];
                await fs.unlink(tempPath).catch(console.error);
            } else {
                await ctx.reply(
                    'Изображение получено! Теперь отправьте текст рассылки:',
                    {
                        reply_markup: {
                            keyboard: [
                                [ADMIN_ACTIONS.CANCEL_BROADCAST],
                                [MENU_ACTIONS.BACK]
                            ],
                            resize_keyboard: true
                        }
                    }
                );
            }
        } catch (error) {
            console.error('Ошибка при обработке изображения для рассылки:', error);
            await ctx.reply('❌ Произошла ошибка при обработке изображения');
        }
        return;
    }

    // Обычная обработка фотографии
    const userId = ctx.from.id;
    let processingMsg;
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            await sendMessageWithImage(
                ctx,
                IMAGES.PAYMENT,
                'У вас закончились кредиты. Используйте команду /buy для покупки дополнительных кредитов.',
                getMainKeyboard()
            );
            return;
        }

        await sendMessageWithImage(
            ctx,
            IMAGES.PAYMENT_PROCESS,
            '⚠️ Важные правила:\n\n' +
            '1. Изображение должно содержать только людей старше 18 лет\n' +
            '2. Убедитесь, что на фото чётко видно лицо\n' +
            '3. Изображение должно быть хорошего качества\n\n' +
            '⏳ Начинаю обработку...'
        );

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

        const isAdult = await isAdultContent();
        if (!isAdult) {
            throw new Error('AGE_RESTRICTION');
        }

        console.log('Отправка изображения на обработку...');
        const result = await processImage(imageBuffer, userId);

        if (result.idGen) {
            await useCredit(userId);
            await sendMessageWithImage(
                ctx,
                IMAGES.PAYMENT_PROCESS,
                '✅ Изображение принято на обработку:\n' +
                `🕒 Время в очереди: ${result.queueTime} сек\n` +
                `📊 Позиция в очереди: ${result.queueNum}\n` +
                `🔄 ID задачи: ${result.idGen}\n\n` +
                'Результат будет отправлен, когда обработка завершится.',
                getMainKeyboard()
            );
        }

        if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }

    } catch (error) {
        let errorMessage = '❌ Произошла ошибка при обработке изображения.';
        
        if (error instanceof Error) {
            console.error('Ошибка при обработке изображения:', error.message);
            
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

        await sendMessageWithImage(
            ctx,
            IMAGES.PAYMENT,
            errorMessage,
            getMainKeyboard()
        );

        if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }
    }
});

// Webhook endpoints
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        scheduledBroadcasts: scheduledBroadcasts.size
    });
});

// Webhook handler для Clothoff
app.post('/webhook', upload.any(), async (req, res) => {
    try {
        console.log('Получен webhook запрос');
        console.log('Headers:', req.headers);
        console.log('Body:', req.body);
        console.log('Files:', req.files);

        const body = req.body as WebhookBody;
        const files = req.files as Express.Multer.File[] || [];

        if (body.status === '500' || body.img_message || body.img_message_2) {
            console.log(`Ошибка обработки изображения: ${body.img_message || body.img_message_2}`);
            
            const userQuery = await pool.query(
                'SELECT user_id FROM users WHERE pending_task_id = $1',
                [body.id_gen]
            );

            if (userQuery.rows.length > 0) {
                const userId = userQuery.rows[0].user_id;
                let errorMessage = '❌ Не удалось обработать изображение:\n\n';

                if (body.img_message?.includes('Age is too young') || body.img_message_2?.includes('Age is too young')) {
                    errorMessage += '🔞 На изображении обнаружен человек младше 18 лет.\n' +
                                  'Обработка таких изображений запрещена.';
                } else {
                    errorMessage += body.img_message || body.img_message_2 || 'Неизвестная ошибка';
                }

                try {
                    await sendMessageWithImageBot(
                        bot,
                        userId,
                        IMAGES.PAYMENT,
                        errorMessage,
                        getMainKeyboard()
                    );
                    await returnCredit(userId);
                    await sendMessageWithImageBot(
                        bot,
                        userId,
                        IMAGES.BALANCE,
                        '💳 Кредит был возвращен из-за ошибки обработки.',
                        getMainKeyboard()
                    );
                    
                    await pool.query(
                        'UPDATE users SET pending_task_id = NULL WHERE user_id = $1',
                        [userId]
                    );
                } catch (sendError) {
                    console.error('Ошибка при отправке сообщения об ошибке:', sendError);
                }
            }

            return res.status(200).json({ success: true, error: body.img_message || body.img_message_2 });
        }

        if (!body.result && files.length === 0) {
            console.log('Нет результата в запросе');
            return res.status(200).json({ success: true });
        }

        const userQuery = await pool.query(
            'SELECT user_id FROM users WHERE pending_task_id = $1',
            [body.id_gen]
        );

        if (userQuery.rows.length > 0) {
            const userId = userQuery.rows[0].user_id;

            try {
                console.log('Отправка результата пользователю:', userId);
                
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
                        { caption: '✨ Обработка изображения завершена!' }
                    );
                    await sendMessageWithImageBot(
                        bot,
                        userId,
                        IMAGES.PAYMENT_PROCESS,
                        '✨ Ваше изображение готово!\n\n' +
                        'Используйте команду /buy для покупки дополнительных кредитов.',
                        getMainKeyboard()
                    );
                }

                await pool.query(
                    'UPDATE users SET pending_task_id = NULL WHERE user_id = $1',
                    [userId]
                );
                console.log('Результат успешно отправлен пользователю');
            } catch (sendError) {
                console.error('Ошибка при отправке результата пользователю:', sendError);
            }
        } else {
            console.log('Пользователь не найден для задачи:', body.id_gen);
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

        const rukassaPayment = new RukassaPayment(pool, bot);
        await rukassaPayment.initPaymentsTable();
        console.log('Таблица платежей инициализирована');

        setupPaymentCommands(bot, pool);
        setupRukassaWebhook(app, rukassaPayment);
        console.log('Платежная система инициализирована');
        
        // Восстановление отложенных рассылок при перезапуске
        const scheduledTasks = await pool.query(`
            SELECT * FROM scheduled_broadcasts 
            WHERE scheduled_time > NOW()
        `).catch(() => ({ rows: [] }));

        for (const task of scheduledTasks.rows) {
            scheduleBroadcast(
                bot,
                new Date(task.scheduled_time),
                task.message,
                task.image_path
            );
        }

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Webhook сервер запущен на порту ${PORT}`);
        });

        await bot.launch();
        console.log('Бот запущен');
    } catch (error) {
        console.error('Ошибка при запуске приложения:', error);
        setTimeout(() => process.exit(1), 1000);
    }
}

// Graceful shutdown
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    pool.end();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    pool.end();
});

start();