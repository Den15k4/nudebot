import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
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

// Проверка переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U';
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app/webhook';
const PORT = parseInt(process.env.PORT || '8080', 10);
const RULES_URL = 'https://telegra.ph/Pravila-ispolzovaniya-bota-03-27';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

// Константы для меню и действий
const MENU_ACTIONS = {
    BUY_CREDITS: '💳 Купить кредиты',
    CHECK_BALANCE: '💰 Баланс',
    INFORMATION: 'ℹ️ Информация',
    HELP: '❓ Помощь',
    BACK: '◀️ Назад',
    ACCEPT_RULES: '✅ Принимаю правила',
    VIEW_RULES: '📜 Правила использования'
};

const ADMIN_ACTIONS = {
    BROADCAST: '📢 Рассылка',
    SCHEDULE: '🕒 Отложенная рассылка',
    STATS: '📊 Статистика',
    CANCEL_BROADCAST: '❌ Отменить рассылку'
};

// Константы для изображений
const IMAGES = {
    WELCOME: path.join(__dirname, '../assets/welcome.jpg'),
    BALANCE: path.join(__dirname, '../assets/balance.jpg'),
    PAYMENT: path.join(__dirname, '../assets/payment.jpg'),
    PAYMENT_PROCESS: path.join(__dirname, '../assets/payment_process.jpg'),
    REFERRAL: path.join(__dirname, '../assets/referral.jpg')
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

interface ScheduledBroadcast {
    id: string;
    date: Date;
    message: string;
    image?: string;
    keyboard?: any;
}

// Состояния для рассылок
const scheduledBroadcasts = new Map<string, Job>();
const awaitingBroadcastMessage = new Set<number>();
const awaitingBroadcastDate = new Set<number>();
const broadcastImage: { [key: number]: string } = {};

// Функции для клавиатур
function getMainKeyboard() {
    return {
        reply_markup: Markup.keyboard([
            [MENU_ACTIONS.BUY_CREDITS, MENU_ACTIONS.CHECK_BALANCE],
            [MENU_ACTIONS.INFORMATION, MENU_ACTIONS.HELP],
            [MENU_ACTIONS.BACK]
        ]).resize()
    };
}

function getInitialKeyboard() {
    return {
        reply_markup: Markup.keyboard([
            [MENU_ACTIONS.VIEW_RULES],
            [MENU_ACTIONS.ACCEPT_RULES],
            [MENU_ACTIONS.HELP]
        ]).resize()
    };
}

function getAdminKeyboard() {
    return {
        reply_markup: Markup.keyboard([
            [ADMIN_ACTIONS.BROADCAST, ADMIN_ACTIONS.SCHEDULE],
            [ADMIN_ACTIONS.STATS, ADMIN_ACTIONS.CANCEL_BROADCAST],
            [MENU_ACTIONS.BACK]
        ]).resize()
    };
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

// Настройка multer
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
        headers: req.headers
    });
    next();
});

app.use(express.json());
// Вспомогательные функции для отправки сообщений


interface MessageOptions {
    reply_markup?: any;
    parse_mode?: string;
    [key: string]: any;
}

async function sendMessageWithImage(
    ctx: any, 
    imagePath: string, 
    text: string, 
    options?: MessageOptions
) {
    try {
        const image = await fs.readFile(imagePath);
        await ctx.replyWithPhoto(
            { source: image },
            {
                caption: text,
                parse_mode: 'HTML',
                ...options
            }
        );
    } catch (error) {
        console.error('Ошибка при отправке сообщения с изображением:', error);
        if (options?.reply_markup) {
            await ctx.reply(text, options);
        } else {
            await ctx.reply(text);
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
        } else {
            const columnExists = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.columns 
                    WHERE table_name = 'users' 
                    AND column_name = 'accepted_rules'
                );
            `);

            if (!columnExists.rows[0].exists) {
                await client.query(`
                    ALTER TABLE users 
                    ADD COLUMN accepted_rules BOOLEAN DEFAULT FALSE;
                `);
                console.log('Добавлена колонка accepted_rules');
            }
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

// Функции для работы с пользователями
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

// Функции для рассылок
async function broadcastMessage(
    bot: Telegraf,
    message: string,
    image?: string,
    keyboard?: any,
    onlyActive: boolean = false
): Promise<{ success: number; failed: number }> {
    const users = onlyActive ? await getActiveUsers() : await getAllUsers();
    let successCount = 0;
    let failedCount = 0;

    for (const user of users) {
        try {
            if (image) {
                await sendMessageWithImageBot(
                    bot,
                    user.user_id,
                    image,
                    message,
                    keyboard
                );
            } else {
                await bot.telegram.sendMessage(
                    user.user_id,
                    message,
                    {
                        parse_mode: 'HTML',
                        ...keyboard
                    }
                );
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
    keyboard?: any
): string {
    const broadcastId = `broadcast_${Date.now()}`;
    
    const job = scheduleJob(date, async () => {
        try {
            await broadcastMessage(bot, message, image, keyboard);
            scheduledBroadcasts.delete(broadcastId);
            
            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(
                        adminId,
                        `✅ Отложенная рассылка выполнена:\n${message.substring(0, 100)}...`
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
// Middleware для проверки принятия правил
async function requireAcceptedRules(ctx: any, next: () => Promise<void>) {
    try {
        const userId = ctx.from?.id.toString();
        
        // Разрешаем админам обходить проверку правил
        if (isAdmin(userId)) {
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

        const accepted = await hasAcceptedRules(ctx.from?.id);
        if (!accepted) {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '⚠️ Для использования бота необходимо принять правила.\n' +
                'Используйте команду /start для просмотра правил.',
                getMainKeyboard()
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
                { reply_markup: getInitialKeyboard() }
            );
        } else {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '🤖 С возвращением!\n\n' +
                'Для обработки изображений необходимы кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Используйте кнопки меню для навигации:',
                { reply_markup: getMainKeyboard() }
            );
        }
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Команды админа
bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id.toString())) {
        return;
    }

    await ctx.reply(
        '👨‍💼 Панель администратора\n\n' +
        'Выберите действие:',
        { reply_markup: getAdminKeyboard() }
    );
});

// Обработчики кнопок админа
bot.hears(ADMIN_ACTIONS.BROADCAST, async (ctx) => {
    if (!isAdmin(ctx.from.id.toString())) return;

    awaitingBroadcastMessage.add(ctx.from.id);
    await ctx.reply(
        '📢 Выберите тип рассылки:\n\n' +
        '1. Отправьте текст для обычной рассылки\n' +
        '2. Отправьте изображение с текстом для рассылки с картинкой\n\n' +
        'Для отмены нажмите "Отменить рассылку"',
        {
            reply_markup: Markup.keyboard([
                [ADMIN_ACTIONS.CANCEL_BROADCAST],
                [MENU_ACTIONS.BACK]
            ]).resize()
        }
    );
});

bot.hears(ADMIN_ACTIONS.SCHEDULE, async (ctx) => {
    if (!isAdmin(ctx.from.id.toString())) return;

    awaitingBroadcastDate.add(ctx.from.id);
    await ctx.reply(
        '🕒 Отправьте дату и время рассылки в формате:\n' +
        'DD.MM.YYYY HH:mm\n\n' +
        'Например: 25.12.2024 15:30\n\n' +
        'Для отмены нажмите "Отменить рассылку"',
        {
            reply_markup: Markup.keyboard([
                [ADMIN_ACTIONS.CANCEL_BROADCAST],
                [MENU_ACTIONS.BACK]
            ]).resize()
        }
    );
});

bot.hears(ADMIN_ACTIONS.STATS, async (ctx) => {
    if (!isAdmin(ctx.from.id.toString())) return;

    try {
        const totalUsers = (await getAllUsers()).length;
        const activeToday = (await getActiveUsers(1)).length;
        const activeWeek = (await getActiveUsers(7)).length;
        const activeMonth = (await getActiveUsers(30)).length;

        const creditsStats = await pool.query(`
            SELECT 
                COUNT(*) as total_users,
                SUM(credits) as total_credits,
                AVG(credits) as avg_credits,
                MAX(credits) as max_credits
            FROM users
            WHERE accepted_rules = TRUE
        `);

        const paymentStats = await pool.query(`
            SELECT 
                COUNT(*) as total_payments,
                SUM(amount) as total_amount
            FROM payments 
            WHERE status = 'paid'
        `);

        await sendMessageWithImage(
            ctx,
            IMAGES.BALANCE,
            '📊 <b>Статистика бота:</b>\n\n' +
            `👥 Всего пользователей: ${totalUsers}\n` +
            `📅 Активных за 24 часа: ${activeToday}\n` +
            `📅 Активных за неделю: ${activeWeek}\n` +
            `📅 Активных за месяц: ${activeMonth}\n\n` +
            `💳 Статистика кредитов:\n` +
            `• Всего: ${creditsStats.rows[0].total_credits || 0}\n` +
            `• Среднее на пользователя: ${Math.round(creditsStats.rows[0].avg_credits || 0)}\n` +
            `• Максимум у пользователя: ${creditsStats.rows[0].max_credits || 0}\n\n` +
            `💰 Статистика платежей:\n` +
            `• Количество: ${paymentStats.rows[0].total_payments || 0}\n` +
            `• Общая сумма: ${paymentStats.rows[0].total_amount || 0} RUB\n\n` +
            `📩 Запланированных рассылок: ${scheduledBroadcasts.size}`,
            { reply_markup: getAdminKeyboard() }
        );
    } catch (error) {
        console.error('Ошибка при получении статистики:', error);
        await ctx.reply('❌ Произошла ошибка при получении статистики');
    }
});

bot.hears(ADMIN_ACTIONS.CANCEL_BROADCAST, async (ctx) => {
    if (!isAdmin(ctx.from.id.toString())) return;

    awaitingBroadcastMessage.delete(ctx.from.id);
    awaitingBroadcastDate.delete(ctx.from.id);
    delete broadcastImage[ctx.from.id];

    await ctx.reply(
        '❌ Рассылка отменена',
        { reply_markup: getAdminKeyboard() }
    );
});

// Обработка сообщений для рассылки
bot.on(message('text'), async (ctx) => {
    if (!isAdmin(ctx.from.id.toString())) return;

    if (awaitingBroadcastMessage.has(ctx.from.id)) {
        const text = ctx.message.text;
        
        try {
            const status = await ctx.reply('⏳ Начинаю рассылку...');
            const result = await broadcastMessage(
                bot, 
                text, 
                broadcastImage[ctx.from.id]
            );

            await ctx.telegram.editMessageText(
                ctx.chat.id,
                status.message_id,
                undefined,
                `✅ Рассылка завершена!\n\n` +
                `Успешно: ${result.success}\n` +
                `Ошибок: ${result.failed}`
            );

            awaitingBroadcastMessage.delete(ctx.from.id);
            delete broadcastImage[ctx.from.id];

            await ctx.reply(
                '👨‍💼 Вернуться в панель администратора?',
                { reply_markup: getAdminKeyboard() }
            );
        } catch (error) {
            console.error('Ошибка при рассылке:', error);
            await ctx.reply('❌ Произошла ошибка при рассылке');
        }
        return;
    }

    if (awaitingBroadcastDate.has(ctx.from.id)) {
        const dateStr = ctx.message.text;
        
        try {
            const [datePart, timePart] = dateStr.split(' ');
            const [day, month, year] = datePart.split('.');
            const [hours, minutes] = timePart.split(':');
            
            const date = new Date(
                parseInt(year),
                parseInt(month) - 1,
                parseInt(day),
                parseInt(hours),
                parseInt(minutes)
            );
            
            if (isNaN(date.getTime()) || date <= new Date()) {
                await ctx.reply('❌ Некорректная дата или дата в прошлом. Попробуйте еще раз.');
                return;
            }

            awaitingBroadcastMessage.add(ctx.from.id);
            awaitingBroadcastDate.delete(ctx.from.id);

            await ctx.reply(
                `🕒 Дата установлена: ${date.toLocaleString()}\n\n` +
                'Теперь отправьте текст рассылки:',
                {
                    reply_markup: Markup.keyboard([
                        [ADMIN_ACTIONS.CANCEL_BROADCAST],
                        [MENU_ACTIONS.BACK]
                    ]).resize()
                }
            );
        } catch (error) {
            console.error('Ошибка при установке даты:', error);
            await ctx.reply('❌ Неверный формат даты. Используйте формат DD.MM.YYYY HH:mm');
        }
    }
});

// Обработка изображений для рассылки
bot.on(message('photo'), async (ctx) => {
    if (!isAdmin(ctx.from.id.toString())) return;

    if (awaitingBroadcastMessage.has(ctx.from.id)) {
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
                    { reply_markup: getAdminKeyboard() }
                );

                awaitingBroadcastMessage.delete(ctx.from.id);
                delete broadcastImage[ctx.from.id];
                await fs.unlink(tempPath).catch(console.error);
            } else {
                await ctx.reply(
                    'Изображение получено! Теперь отправьте текст рассылки:',
                    {
                        reply_markup: Markup.keyboard([
                            [ADMIN_ACTIONS.CANCEL_BROADCAST],
                            [MENU_ACTIONS.BACK]
                        ]).resize()
                    }
                );
            }
        } catch (error) {
            console.error('Ошибка при обработке изображения для рассылки:', error);
            await ctx.reply('❌ Произошла ошибка при обработке изображения');
        }
    }
});