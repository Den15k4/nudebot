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
import { RukassaPayment, setupPaymentCommands, setupRukassaWebhook } from './rukassa';

dotenv.config();

// Проверка переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U';
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app/webhook';
const PORT = parseInt(process.env.PORT || '8080', 10);
const RULES_URL = 'https://telegra.ph/Pravila-ispolzovaniya-bota-03-27';

// Константы для кнопок и клавиатур
const BACK_BUTTON = '◀️ Назад';

const DEFAULT_KEYBOARD = Markup.keyboard([
    ['💳 Купить кредиты', '💰 Баланс'],
    ['ℹ️ Информация', '❓ Помощь'],
    [BACK_BUTTON]
]).resize();

const INITIAL_KEYBOARD = Markup.keyboard([
    ['📜 Правила использования'],
    ['✅ Принимаю правила'],
    ['❓ Помощь'],
    [BACK_BUTTON]
]).resize();

// Константы для изображений
const IMAGES = {
    WELCOME: path.join(__dirname, '../assets/welcome.jpg'),
    BALANCE: path.join(__dirname, '../assets/balance.jpg'),
    PAYMENT: path.join(__dirname, '../assets/payment.jpg'),
    PAYMENT_PROCESS: path.join(__dirname, '../assets/payment_process.jpg'),
    REFERRAL: path.join(__dirname, '../assets/referral.jpg')
};

// Вспомогательная функция для отправки сообщения с изображением и кнопками
async function sendMessageWithImage(
    ctx: any, 
    imagePath: string, 
    text: string, 
    keyboard?: any
) {
    try {
        const image = await fs.readFile(imagePath);
        if (keyboard) {
            await ctx.replyWithPhoto(
                { source: image },
                {
                    caption: text,
                    parse_mode: 'HTML',
                    ...keyboard
                }
            );
        } else {
            await ctx.replyWithPhoto(
                { source: image },
                {
                    caption: text,
                    parse_mode: 'HTML'
                }
            );
        }
    } catch (error) {
        console.error('Ошибка при отправке сообщения с изображением:', error);
        if (keyboard) {
            await ctx.reply(text, keyboard);
        } else {
            await ctx.reply(text);
        }
    }
}

// Вспомогательная функция для отправки сообщения с изображением через bot
async function sendMessageWithImageBot(
    bot: Telegraf,
    userId: number,
    imagePath: string,
    text: string,
    keyboard?: any
) {
    try {
        const image = await fs.readFile(imagePath);
        if (keyboard) {
            await bot.telegram.sendPhoto(
                userId,
                { source: image },
                {
                    caption: text,
                    parse_mode: 'HTML',
                    ...keyboard
                }
            );
        } else {
            await bot.telegram.sendPhoto(
                userId,
                { source: image },
                {
                    caption: text,
                    parse_mode: 'HTML'
                }
            );
        }
    } catch (error) {
        console.error('Ошибка при отправке сообщения с изображением:', error);
        if (keyboard) {
            await bot.telegram.sendMessage(userId, text, keyboard);
        } else {
            await bot.telegram.sendMessage(userId, text);
        }
    }
}

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

app.use((req, res, next) => {
    console.log('Входящий запрос:', {
        method: req.method,
        path: req.path,
        headers: req.headers
    });
    next();
});

app.use(express.json());
// Создание таблиц в базе данных
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

// Функция проверки возраста
async function isAdultContent(): Promise<boolean> {
    try {
        return true;
    } catch (error) {
        console.error('Ошибка при проверке содержимого:', error);
        return false;
    }
}

// Функция проверки принятия правил
async function hasAcceptedRules(userId: number): Promise<boolean> {
    try {
        const columnExists = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.columns 
                WHERE table_name = 'users' 
                AND column_name = 'accepted_rules'
            );
        `);

        if (!columnExists.rows[0].exists) {
            return false;
        }

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

// Middleware для проверки принятия правил
async function requireAcceptedRules(ctx: any, next: () => Promise<void>) {
    try {
        if (
            ctx.message?.text === '/start' || 
            ctx.message?.text === BACK_BUTTON || 
            ctx.message?.text === '📜 Правила использования' ||
            ctx.message?.text === '✅ Принимаю правила' ||
            ctx.callbackQuery?.data === 'accept_rules'
        ) {
            return next();
        }

        const userId = ctx.from?.id;
        if (!userId) {
            return;
        }

        const accepted = await hasAcceptedRules(userId);
        if (!accepted) {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '⚠️ Для использования бота необходимо принять правила.\n' +
                'Используйте команду /start для просмотра правил.',
                { reply_markup: INITIAL_KEYBOARD }
            );
            return;
        }

        return next();
    } catch (error) {
        console.error('Ошибка в middleware проверки правил:', error);
        return next();
    }
}

// Функции работы с пользователями
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
            console.error('API Error Response:', error.response.data);
            if (error.response.data.error === 'Insufficient balance') {
                throw new Error('INSUFFICIENT_BALANCE');
            }
            throw new Error(`API Error: ${error.response.data.error || 'Unknown error'}`);
        }
        throw error;
    }
}

// Применяем middleware
bot.use(requireAcceptedRules);

// Обработчики команд бота
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
                { reply_markup: INITIAL_KEYBOARD }
            );
        } else {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '🤖 С возвращением!\n\n' +
                'Для обработки изображений необходимы кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Используйте кнопки меню для навигации:',
                { reply_markup: DEFAULT_KEYBOARD }
            );
        }
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Обработчик кнопки "Назад"
bot.hears(BACK_BUTTON, async (ctx) => {
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
                { reply_markup: INITIAL_KEYBOARD }
            );
        } else {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '🤖 Главное меню\n\n' +
                'Для обработки изображений необходимы кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Используйте кнопки меню для навигации:',
                { reply_markup: DEFAULT_KEYBOARD }
            );
        }
    } catch (error) {
        console.error('Ошибка при возврате в главное меню:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

bot.hears('📜 Правила использования', async (ctx) => {
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
        { reply_markup: INITIAL_KEYBOARD }
    );
});

bot.hears('✅ Принимаю правила', async (ctx) => {
    try {
        const userId = ctx.from?.id;
        if (!userId) return;

        const result = await pool.query(
            'UPDATE users SET accepted_rules = TRUE WHERE user_id = $1 RETURNING accepted_rules',
            [userId]
        );

        if (result.rows.length > 0 && result.rows[0].accepted_rules) {
            await sendMessageWithImage(
                ctx,
                IMAGES.WELCOME,
                '✅ Спасибо за принятие правил!\n\n' +
                '🤖 Теперь вы можете использовать бота.\n\n' +
                'Для начала работы необходимо приобрести кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Используйте кнопки меню для навигации:',
                { reply_markup: DEFAULT_KEYBOARD }
            );
        }
    } catch (error) {
        console.error('Ошибка при принятии правил:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
});

bot.hears('💳 Купить кредиты', async (ctx) => {
    await sendMessageWithImage(
        ctx,
        IMAGES.PAYMENT,
        '💳 Выберите способ оплаты:',
        {
            reply_markup: {
                inline_keyboard: [
                    [Markup.button.callback('💳 Visa/MC (RUB)', 'currency_RUB')],
                    [Markup.button.callback('💳 Visa/MC (KZT)', 'currency_KZT')],
                    [Markup.button.callback('💳 Visa/MC (UZS)', 'currency_UZS')],
                    [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')]
                ]
            }
        }
    );
});

bot.hears('💰 Баланс', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const credits = await checkCredits(userId);
        await sendMessageWithImage(
            ctx,
            IMAGES.BALANCE,
            `💳 У вас ${credits} кредитов`,
            { reply_markup: DEFAULT_KEYBOARD }
        );
    } catch (error) {
        console.error('Ошибка при проверке кредитов:', error);
        await ctx.reply('Произошла ошибка при проверке кредитов. Попробуйте позже.');
    }
});

bot.hears('ℹ️ Информация', async (ctx) => {
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
        { reply_markup: DEFAULT_KEYBOARD }
    );
});

bot.hears('❓ Помощь', async (ctx) => {
    await sendMessageWithImage(
        ctx,
        IMAGES.WELCOME,
        '❓ <b>Помощь:</b>\n\n' +
        'Доступные команды:\n' +
        '/start - Перезапустить бота\n' +
        '/buy - Купить кредиты\n' +
        '/credits - Проверить баланс\n\n' +
        'При возникновении проблем обращайтесь в поддержку: @support',
        { reply_markup: DEFAULT_KEYBOARD }
    );
});

bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    let processingMsg;
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            await sendMessageWithImage(
                ctx,
                IMAGES.PAYMENT,
                'У вас закончились кредиты. Используйте команду /buy для покупки дополнительных кредитов.',
                { reply_markup: DEFAULT_KEYBOARD }
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

        if (!await isAdultContent()) {
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
                { reply_markup: DEFAULT_KEYBOARD }
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
            { reply_markup: DEFAULT_KEYBOARD }
        );

        if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }
    }
});

// Express endpoints
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
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
                        { reply_markup: DEFAULT_KEYBOARD }
                    );
                    await returnCredit(userId);
                    await sendMessageWithImageBot(
                        bot,
                        userId,
                        IMAGES.BALANCE,
                        '💳 Кредит был возвращен из-за ошибки обработки.',
                        { reply_markup: DEFAULT_KEYBOARD }
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
                    await bot.telegram.sendPhoto(userId, { source: imageBuffer });
                    await sendMessageWithImageBot(
                        bot,
                        userId,
                        IMAGES.PAYMENT_PROCESS,
                        '✨ Обработка изображения завершена!',
                        { reply_markup: DEFAULT_KEYBOARD }
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