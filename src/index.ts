import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import FormData from 'form-data';
import express from 'express';
import multer from 'multer';
import { RukassaPayment, setupPaymentCommands, setupRukassaWebhook } from './rukassa';
import { MultiBotManager } from './multibot';

dotenv.config();

// Конфигурационные параметры
const BOT_TOKEN = process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U';
const CLOTHOFF_API_KEY = process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app/webhook';
const PORT = parseInt(process.env.PORT || '8080', 10);

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

// Инициализация менеджера ботов
const multiBotManager = new MultiBotManager(pool);

// Инициализация основного бота
const mainBot = new Telegraf(BOT_TOKEN);

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

// Создание таблиц в базе данных
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Создание базовых таблиц с поддержкой реферальной системы
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                credits INT DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMPTZ,
                pending_task_id TEXT,
                referral_id BIGINT,
                total_referral_earnings DECIMAL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS referral_withdrawals (
                id SERIAL PRIMARY KEY,
                user_id BIGINT REFERENCES users(user_id),
                amount DECIMAL NOT NULL,
                status TEXT DEFAULT 'pending',
                payment_details JSONB,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                processed_at TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS referral_earnings (
                id SERIAL PRIMARY KEY,
                referrer_id BIGINT REFERENCES users(user_id),
                referred_id BIGINT REFERENCES users(user_id),
                payment_id INTEGER REFERENCES payments(id),
                amount DECIMAL NOT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
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

// Функции работы с пользователями
async function checkCredits(userId: number, botId: string = 'main'): Promise<number> {
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

async function useCredit(userId: number, botId: string = 'main'): Promise<void> {
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

async function returnCredit(userId: number, botId: string = 'main'): Promise<void> {
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

async function addNewUser(userId: number, username: string | undefined, botId: string = 'main', referrerId?: number): Promise<void> {
    try {
        await pool.query(
            'INSERT INTO users (user_id, username, credits, referral_id) VALUES ($1, $2, 1, $3) ON CONFLICT (user_id) DO NOTHING',
            [userId, username || 'anonymous', referrerId]
        );
    } catch (error) {
        console.error('Ошибка при добавлении пользователя:', error);
        throw error;
    }
}

// Проверка возраста
async function isAdultContent(): Promise<boolean> {
    try {
        return true;
    } catch (error) {
        console.error('Ошибка при проверке содержимого:', error);
        return false;
    }
}

// Обработка изображения через API
async function processImage(imageBuffer: Buffer, userId: number, botId: string = 'main'): Promise<ProcessingResult> {
    const formData = new FormData();
    const id_gen = `${botId}_${userId}_${Date.now()}`;
    
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
            console.error('API Error Response:', error.response.data);
            if (error.response.data.error === 'Insufficient balance') {
                throw new Error('INSUFFICIENT_BALANCE');
            }
            throw new Error(`API Error: ${error.response.data.error || 'Unknown error'}`);
        }
        throw error;
    }
}

// Настройка обработчиков бота
mainBot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const args = ctx.message.text.split(' ');
        const referralCode = args[1];

        if (referralCode) {
            try {
                const referrerId = parseInt(Buffer.from(referralCode, 'base64').toString('ascii'));
                if (referrerId && referrerId !== userId) {
                    await addNewUser(userId, username, 'main', referrerId);
                } else {
                    await addNewUser(userId, username);
                }
            } catch {
                await addNewUser(userId, username);
            }
        } else {
            await addNewUser(userId, username);
        }

        const keyboard = {
            keyboard: [
                [{ text: '💰 Баланс' }, { text: '💳 Купить кредиты' }],
                [{ text: '👥 Реферальная программа' }, { text: '❓ Помощь' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        };

        await ctx.replyWithAnimation(
            'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcDJ6a3E4Y2pwZnJ1NHgzOXF1NjE5ZDR0N2JyMm04bTF1YzNwY2twdyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/l3V0H9FSPSqz4GS52/giphy.gif',
            {
                caption: 'Привет! Я бот для обработки изображений. 🌟\n\n' +
                    '🎁 У вас есть 1 бесплатный кредит.\n' +
                    '📸 Отправьте мне изображение, и я обработаю его.\n\n' +
                    '🤝 Пригласите друзей и получайте 50% от их оплаты!',
                reply_markup: keyboard
            }
        );
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

mainBot.hears('💰 Баланс', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const credits = await checkCredits(userId);
        const earnings = await pool.query(
            'SELECT total_referral_earnings FROM users WHERE user_id = $1',
            [userId]
        );
        
        await ctx.reply(
            `💳 Ваш баланс: ${credits} кредитов\n` +
            `💰 Реферальный заработок: ${earnings.rows[0].total_referral_earnings || 0}₽\n\n` +
            `Чтобы вывести средства, нажмите кнопку "👥 Реферальная программа"`
        );
    } catch (error) {
        console.error('Ошибка при проверке баланса:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

mainBot.hears('👥 Реферальная программа', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const referralCode = Buffer.from(userId.toString()).toString('base64');
        const botUsername = (await ctx.telegram.getMe()).username;
        
        const stats = await pool.query(`
            SELECT 
                COUNT(DISTINCT u.user_id) as total_referrals,
                COALESCE(SUM(re.amount), 0) as total_earnings,
                COALESCE((SELECT total_referral_earnings FROM users WHERE user_id = $1), 0) as available_balance
            FROM users u
            LEFT JOIN referral_earnings re ON re.referrer_id = $1
            WHERE u.referral_id = $1
        `, [userId]);

        await ctx.reply(
            `👥 Ваша реферальная программа:\n\n` +
            `🔗 Ваша ссылка для приглашения:\n` +
            `https://t.me/${botUsername}?start=${referralCode}\n\n` +
            `📊 Статистика:\n` +
            `• Приглашено пользователей: ${stats.rows[0].total_referrals}\n` +
            `• Всего заработано: ${stats.rows[0].total_earnings}₽\n` +
            `• Доступно к выводу: ${stats.rows[0].available_balance}₽\n\n` +
            `💡 Приглашайте друзей и получайте 50% от каждой их оплаты!`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💰 Вывести средства', callback_data: 'withdraw_earnings' }],
                        [{ text: '📊 История начислений', callback_data: 'earnings_history' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка в реферальной программе:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

mainBot.hears('❓ Помощь', async (ctx) => {
    await ctx.reply(
        '🤖 Как пользоваться ботом:\n\n' +
        '1. Отправьте боту фотографию\n' +
        '2. Дождитесь обработки\n' +
        '3. Получите результат\n\n' +
        '💳 Один кредит = одна обработка\n\n' +
        '👥 Реферальная программа:\n' +
       '• Приглашайте друзей по вашей реферальной ссылке\n' +
        '• Получайте 50% от каждого их платежа\n' +
        '• Минимальная сумма для вывода: 100₽\n\n' +
        'По всем вопросам обращайтесь к @admin'
    );
});

mainBot.hears('💳 Купить кредиты', async (ctx) => {
    try {
        await ctx.reply('💳 Выберите способ оплаты:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💳 Visa/MC (RUB)', callback_data: 'currency_RUB' }],
                    [{ text: '💳 Visa/MC (KZT)', callback_data: 'currency_KZT' }],
                    [{ text: '💳 Visa/MC (UZS)', callback_data: 'currency_UZS' }],
                    [{ text: '💎 Криптовалюта', callback_data: 'currency_CRYPTO' }]
                ]
            }
        });
    } catch (error) {
        console.error('Ошибка при выборе способа оплаты:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

mainBot.action('withdraw_earnings', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const user = await pool.query(
            'SELECT total_referral_earnings FROM users WHERE user_id = $1',
            [userId]
        );
        
        if (!user.rows[0].total_referral_earnings || user.rows[0].total_referral_earnings < 100) {
            await ctx.answerCbQuery('Минимальная сумма для вывода: 100₽');
            return;
        }

        await ctx.reply(
            '💳 Введите ваши реквизиты для вывода средств в формате:\n' +
            '/withdraw <номер карты или кошелька>\n\n' +
            '⚠️ Минимальная сумма: 100₽'
        );
    } catch (error) {
        console.error('Ошибка при запросе вывода средств:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

mainBot.action('earnings_history', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const history = await pool.query(`
            SELECT 
                re.amount,
                re.created_at,
                u.username as referred_username
            FROM referral_earnings re
            LEFT JOIN users u ON u.user_id = re.referred_id
            WHERE re.referrer_id = $1
            ORDER BY re.created_at DESC
            LIMIT 10
        `, [userId]);

        let message = '📊 История реферальных начислений:\n\n';
        
        if (history.rows.length === 0) {
            message += 'У вас пока нет начислений. Пригласите друзей!';
        } else {
            history.rows.forEach((row, index) => {
                const date = new Date(row.created_at).toLocaleDateString();
                message += `${index + 1}. ${date} - ${row.amount}₽`;
                if (row.referred_username) {
                    message += ` (от @${row.referred_username})`;
                }
                message += '\n';
            });
        }

        await ctx.editMessageText(message, {
            reply_markup: {
                inline_keyboard: [[{ text: '« Назад', callback_data: 'back_to_referral' }]]
            }
        });
    } catch (error) {
        console.error('Ошибка при получении истории начислений:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

mainBot.action('back_to_referral', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const referralCode = Buffer.from(userId.toString()).toString('base64');
        const botUsername = (await ctx.telegram.getMe()).username;
        
        const stats = await pool.query(`
            SELECT 
                COUNT(DISTINCT u.user_id) as total_referrals,
                COALESCE(SUM(re.amount), 0) as total_earnings,
                COALESCE((SELECT total_referral_earnings FROM users WHERE user_id = $1), 0) as available_balance
            FROM users u
            LEFT JOIN referral_earnings re ON re.referrer_id = $1
            WHERE u.referral_id = $1
        `, [userId]);

        await ctx.editMessageText(
            `👥 Ваша реферальная программа:\n\n` +
            `🔗 Ваша ссылка для приглашения:\n` +
            `https://t.me/${botUsername}?start=${referralCode}\n\n` +
            `📊 Статистика:\n` +
            `• Приглашено пользователей: ${stats.rows[0].total_referrals}\n` +
            `• Всего заработано: ${stats.rows[0].total_earnings}₽\n` +
            `• Доступно к выводу: ${stats.rows[0].available_balance}₽\n\n` +
            `💡 Приглашайте друзей и получайте 50% от каждой их оплаты!`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💰 Вывести средства', callback_data: 'withdraw_earnings' }],
                        [{ text: '📊 История начислений', callback_data: 'earnings_history' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при возврате к реферальной программе:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

mainBot.command('withdraw', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const args = ctx.message.text.split(' ');
        const paymentDetails = args.slice(1).join(' ');

        if (!paymentDetails) {
            await ctx.reply('Пожалуйста, укажите реквизиты для вывода средств');
            return;
        }

        const user = await pool.query(
            'SELECT total_referral_earnings FROM users WHERE user_id = $1',
            [userId]
        );

        if (!user.rows[0].total_referral_earnings || user.rows[0].total_referral_earnings < 100) {
            await ctx.reply('Недостаточно средств для вывода. Минимальная сумма: 100₽');
            return;
        }

        await pool.query(
            `INSERT INTO referral_withdrawals (user_id, amount, payment_details, status)
             VALUES ($1, $2, $3, 'pending')`,
            [userId, user.rows[0].total_referral_earnings, { details: paymentDetails }]
        );

        await pool.query(
            'UPDATE users SET total_referral_earnings = 0 WHERE user_id = $1',
            [userId]
        );

        await ctx.reply(
            '✅ Заявка на вывод средств создана!\n' +
            'Средства будут переведены в течение 24 часов.'
        );
    } catch (error) {
        console.error('Ошибка при создании заявки на вывод:', error);
        await ctx.reply('Произошла ошибка при создании заявки. Попробуйте позже.');
    }
});

mainBot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    let processingMsg;
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            return ctx.reply('У вас закончились кредиты. Используйте команду /buy для покупки дополнительных кредитов.');
        }

        await ctx.reply(
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
            await ctx.reply(
                '✅ Изображение принято на обработку:\n' +
                `🕒 Время в очереди: ${result.queueTime} сек\n` +
                `📊 Позиция в очереди: ${result.queueNum}\n` +
                `🔄 ID задачи: ${result.idGen}\n\n` +
                'Результат будет отправлен, когда обработка завершится.'
            );
        }

        if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }

    } catch (error) {
        let errorMessage = '❌ Произошла ошибка при обработке изображения.';
        
        if (error instanceof Error) {
            console.error('Ошибка при обработке изображения:', error.message);
            
            switch (error.message) {
                case 'AGE_RESTRICTION':
                    errorMessage = '🔞 Обработка запрещена: Изображение не прошло проверку возрастных ограничений.';
                    break;
                case 'INSUFFICIENT_BALANCE':
                    errorMessage = '⚠️ Сервис временно недоступен. Попробуйте позже.';
                    break;
                default:
                    errorMessage += `\n${error.message}`;
            }
        }

        await ctx.reply(errorMessage);

        if (processingMsg) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }
    }
});

// Настройка webhook для обработки результатов
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
                    await mainBot.telegram.sendMessage(userId, errorMessage);
                    await returnCredit(userId);
                    await mainBot.telegram.sendMessage(userId, '💳 Кредит был возвращен из-за ошибки обработки.');
                    
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
                    await mainBot.telegram.sendPhoto(userId, { source: imageBuffer });
                    await mainBot.telegram.sendMessage(userId, '✨ Обработка изображения завершена!');
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

// Маршрут проверки здоровья системы
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        botsCount: multiBotManager.getBotsCount()
    });
});

// Запуск приложения
async function start() {
    try {
        await initDB();
        console.log('База данных инициализирована');

        // Настройка основного бота
        setupPaymentCommands(mainBot, pool, 'main');
        console.log('Основной бот настроен');

        // Загрузка дополнительных ботов
        await multiBotManager.loadAllBots();
        console.log('Дополнительные боты загружены');

        // Настройка веб-хуков для платежей
        setupRukassaWebhook(app, multiBotManager);
        console.log('Платежные веб-хуки настроены');

        // Запуск веб-сервера
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Webhook сервер запущен на порту ${PORT}`);
        });

        // Запуск основного бота
        await mainBot.launch();
        console.log('Основной бот запущен');

    } catch (error) {
        console.error('Ошибка при запуске приложения:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.once('SIGINT', async () => {
    console.log('Получен сигнал SIGINT, завершение работы...');
    mainBot.stop('SIGINT');
    await multiBotManager.stopAllBots();
    await pool.end();
});

process.once('SIGTERM', async () => {
    console.log('Получен сигнал SIGTERM, завершение работы...');
    mainBot.stop('SIGTERM');
    await multiBotManager.stopAllBots();
    await pool.end();
});

// Запуск приложения
start();