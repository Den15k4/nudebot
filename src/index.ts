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

// Проверка переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U';
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9';
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
};import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import FormData from 'form-data';
import express from 'express';
import multer from 'multer';
import { RukassaPayment, setupPaymentCommands, setupRukassaWebhook } from './rukassa';

dotenv.config();

// Проверка переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U';
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9';
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

const referralKeyboard = {
    inline_keyboard: [
        [{ text: '♻️ Обновить статистику', callback_data: 'refresh_referrals' }],
        [{ text: '↩️ Вернуться в меню', callback_data: 'back_to_menu' }]
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

        await client.query('DROP TABLE IF EXISTS payments CASCADE;');
        await client.query('DROP TABLE IF EXISTS users CASCADE;');

        await client.query(`
            CREATE TABLE users (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                credits INT DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMPTZ,
                pending_task_id TEXT,
                referrer_id BIGINT,
                total_referrals INT DEFAULT 0,
                referral_earnings DECIMAL DEFAULT 0.0
            );
        `);

        await client.query(`
            CREATE INDEX idx_referrer_id ON users(referrer_id);
        `);

        await client.query(`
            ALTER TABLE users 
            ADD CONSTRAINT fk_referrer 
            FOREIGN KEY (referrer_id) 
            REFERENCES users(user_id) 
            ON DELETE SET NULL;
        `);

        await client.query('COMMIT');
        console.log('База данных инициализирована успешно');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при инициализации базы данных:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Реферальные функции
async function createReferralLink(userId: number): Promise<string> {
    const botInfo = await bot.telegram.getMe();
    return `https://t.me/${botInfo.username}?start=ref${userId}`;
}

async function processReferral(userId: number, referrerId: number): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const existingUser = await client.query(
            'SELECT referrer_id FROM users WHERE user_id = $1',
            [userId]
        );
        
        if (!existingUser.rows[0]?.referrer_id) {
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
            );
        }
        
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при обработке реферала:', error);
        throw error;
    } finally {
        client.release();
    }
}

export async function processReferralPayment(userId: number, paymentAmount: number): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const referrerResult = await client.query(
            'SELECT referrer_id FROM users WHERE user_id = $1',
            [userId]
        );
        
        if (referrerResult.rows[0]?.referrer_id) {
            const referrerId = referrerResult.rows[0].referrer_id;
            const referralBonus = paymentAmount * 0.5;
            
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
        throw error;
    } finally {
        client.release();
    }
}
// Базовые функции
async function getUser(userId: number) {
    const result = await pool.query(
        'SELECT * FROM users WHERE user_id = $1',
        [userId]
    );
    return result.rows[0];
}

async function checkCredits(userId: number): Promise<number> {
    const user = await getUser(userId);
    return user?.credits || 0;
}

async function useCredit(userId: number): Promise<void> {
    await pool.query(
        'UPDATE users SET credits = credits - 1, last_used = CURRENT_TIMESTAMP WHERE user_id = $1',
        [userId]
    );
}

async function returnCredit(userId: number): Promise<void> {
    await pool.query(
        'UPDATE users SET credits = credits + 1 WHERE user_id = $1',
        [userId]
    );
}

async function addNewUser(userId: number, username: string | undefined): Promise<void> {
    await pool.query(
        'INSERT INTO users (user_id, username, credits) VALUES ($1, $2, 1) ON CONFLICT (user_id) DO NOTHING',
        [userId, username || 'anonymous']
    );
}

async function isAdultContent(): Promise<boolean> {
    return true;
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
        console.log('Отправка запроса в API с полями:', {
            cloth: 'naked',
            id_gen,
            webhook: CLOTHOFF_WEBHOOK_URL,
            hasImage: !!imageBuffer,
            timestamp: new Date().toISOString()
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


// Команды бота
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const args = ctx.message.text.split(' ');
        
        if (args[1] && args[1].startsWith('ref')) {
            const referrerId = parseInt(args[1].substring(3));
            if (referrerId && referrerId !== userId) {
                await processReferral(userId, referrerId);
            }
        }

        await addNewUser(userId, username);
        
        await ctx.replyWithPhoto(
            { source: './assets/welcome.jpg' },
            {
                caption: 'Добро пожаловать! 👋\n\n' +
                        'Я помогу вам обработать изображения с помощью нейросети.\n' +
                        'У вас есть 1 бесплатный кредит для начала.\n\n' +
                        'Выберите действие:',
                reply_markup: mainKeyboard
            }
        );
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Обработчики callback-кнопок
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
                '❌ У вас закончились кредиты\n\n' +
                'Пожалуйста, пополните баланс для продолжения работы.',
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
        const user = await getUser(userId);
        
        await ctx.answerCbQuery();
        await ctx.editMessageCaption(
            '💰 Ваш баланс:\n\n' +
            `🎫 Кредитов: ${user.credits}\n` +
            `💎 Реферальный заработок: ${Number(user.referral_earnings).toFixed(2)} RUB\n\n` +
            'Выберите действие:',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Купить кредиты', callback_data: 'buy_credits' }],
                        [{ text: '↩️ Вернуться в меню', callback_data: 'back_to_menu' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при проверке баланса:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

bot.action('buy_credits', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await ctx.editMessageCaption(
            '💳 Выберите способ оплаты:',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Visa/MC (RUB)', callback_data: 'currency_RUB' }],
                        [{ text: '💳 Visa/MC (KZT)', callback_data: 'currency_KZT' }],
                        [{ text: '💳 Visa/MC (UZS)', callback_data: 'currency_UZS' }],
                        [{ text: '💎 Криптовалюта', callback_data: 'currency_CRYPTO' }],
                        [{ text: '↩️ Вернуться в меню', callback_data: 'back_to_menu' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при показе способов оплаты:', error);
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
        const user = await getUser(userId);
        const referralLink = await createReferralLink(userId);
        
        await ctx.answerCbQuery();
        await ctx.editMessageCaption(
            '🤝 Реферальная программа\n\n' +
            '1️⃣ Пригласите друзей по вашей реферальной ссылке\n' +
            '2️⃣ Получайте 50% от суммы их оплат\n\n' +
            `📊 Ваша статистика:\n` +
            `👥 Рефералов: ${user.total_referrals}\n` +
            `💰 Заработано: ${Number(user.referral_earnings).toFixed(2)} RUB\n\n` +
            `🔗 Ваша реферальная ссылка:\n${referralLink}`,
            { reply_markup: referralKeyboard }
        );
    } catch (error) {
        console.error('Ошибка при показе реферальной программы:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

bot.action('refresh_referrals', async (ctx) => {
    try {
        const userId = ctx.from?.id;
        if (!userId) {
            await ctx.answerCbQuery('Ошибка: пользователь не найден');
            return;
        }

        const user = await getUser(userId);
        const referralLink = await createReferralLink(userId);

        await ctx.answerCbQuery('Статистика обновлена!');
        await ctx.editMessageCaption(
            '🤝 Реферальная программа\n\n' +
            '1️⃣ Пригласите друзей по вашей реферальной ссылке\n' +
            '2️⃣ Получайте 50% от суммы их оплат\n\n' +
            `📊 Ваша статистика:\n` +
            `👥 Рефералов: ${user.total_referrals}\n` +
            `💰 Заработано: ${Number(user.referral_earnings).toFixed(2)} RUB\n\n` +
            `🔗 Ваша реферальная ссылка:\n${referralLink}`,
            { reply_markup: referralKeyboard }
        );
    } catch (error) {
        console.error('Ошибка при обновлении статистики:', error);
        await ctx.answerCbQuery('Произошла ошибка при обновлении статистики');
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
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            return ctx.reply(
                '❌ У вас закончились кредиты\n\n' +
                'Пожалуйста, пополните баланс для продолжения работы.',
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

        processingMsg = await ctx.reply(
            '⏳ Начинаю обработку изображения...\n' +
            'Пожалуйста, подождите.',
            { reply_markup: cancelKeyboard }
        );

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
            await ctx.reply(
                '✅ Изображение принято в обработку:\n\n' +
                `⏱ Время в очереди: ${result.queueTime} сек\n` +
                `📊 Позиция в очереди: ${result.queueNum}\n` +
                `🔄 ID задачи: ${result.idGen}\n\n` +
                '🔍 Результат будет отправлен, когда обработка завершится.',
                { reply_markup: mainKeyboard }
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
    
            await ctx.reply(
                errorMessage,
                { reply_markup: mainKeyboard }
            );
    
            if (processingMsg) {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
            }
        }
    });
    
    // Webhook обработчик
    app.post(['/', '/webhook'], upload.any(), async (req, res) => {
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
                        await bot.telegram.sendMessage(userId, errorMessage, { reply_markup: mainKeyboard });
                        await returnCredit(userId);
                        await bot.telegram.sendMessage(
                            userId,
                            '💳 Кредит был возвращен из-за ошибки обработки.',
                            { reply_markup: mainKeyboard }
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
                            {
                                caption: '✨ Обработка изображения завершена!\n' +
                                       'Чтобы обработать новое фото, нажмите кнопку 💫 Начать обработку',
                                reply_markup: mainKeyboard
                            }
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
    
    
    // Health check
    app.get('/health', (req, res) => {
        res.status(200).json({ 
            status: 'ok',
            timestamp: new Date().toISOString()
        });
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
                console.log(`ClothOff webhook URL: ${CLOTHOFF_WEBHOOK_URL}`);
                console.log(`Base webhook URL: ${BASE_WEBHOOK_URL}`);
            });
    
            await bot.launch();
            console.log('Бот запущен');
        } catch (error) {
            console.error('Ошибка при запуске приложения:', error);
            process.exit(1);
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