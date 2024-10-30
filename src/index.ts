import { Telegraf, Markup } from 'telegraf';
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

// Настройка multer для обработки multipart/form-data
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB лимит
    }
});

// Middleware для логирования всех запросов
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
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                credits INT DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMPTZ,
                pending_task_id TEXT,
                referrer_id BIGINT,
                total_referrals INT DEFAULT 0,
                referral_earnings DECIMAL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_referrer_id ON users(referrer_id);
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

// Функции для реферальной системы
async function createReferralLink(userId: number): Promise<string> {
    const botInfo = await bot.telegram.getMe();
    return `https://t.me/${botInfo.username}?start=ref${userId}`;
}

async function processReferral(userId: number, referrerId: number): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Проверяем, не является ли пользователь уже чьим-то рефералом
        const existingUser = await client.query(
            'SELECT referrer_id FROM users WHERE user_id = $1',
            [userId]
        );
        
        if (!existingUser.rows[0].referrer_id) {
            // Обновляем информацию о реферале
            await client.query(
                'UPDATE users SET referrer_id = $1 WHERE user_id = $2',
                [referrerId, userId]
            );
            
            // Увеличиваем счетчик рефералов
            await client.query(
                'UPDATE users SET total_referrals = total_referrals + 1 WHERE user_id = $1',
                [referrerId]
            );

            // Отправляем уведомление рефереру
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
        
        // Получаем информацию о реферере
        const referrerResult = await client.query(
            'SELECT referrer_id FROM users WHERE user_id = $1',
            [userId]
        );
        
        if (referrerResult.rows[0]?.referrer_id) {
            const referrerId = referrerResult.rows[0].referrer_id;
            const referralBonus = paymentAmount * 0.5; // 50% от платежа
            
            // Начисляем бонус рефереру
            await client.query(
                'UPDATE users SET referral_earnings = referral_earnings + $1 WHERE user_id = $2',
                [referralBonus, referrerId]
            );
            
            // Отправляем уведомление рефереру
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

// Функция проверки возраста
async function isAdultContent(): Promise<boolean> {
    try {
        return true;
    } catch (error) {
        console.error('Ошибка при проверке содержимого:', error);
        return false;
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
            'INSERT INTO users (user_id, username, credits) VALUES ($1, $2, 1) ON CONFLICT (user_id) DO NOTHING',
            [userId, username || 'anonymous']
        );
    } catch (error) {
        console.error('Ошибка при добавлении пользователя:', error);
        throw error;
    }
}

// Обработчики команд бота
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const args = ctx.message.text.split(' ');
        
        // Проверяем реферальный код
        if (args[1] && args[1].startsWith('ref')) {
            const referrerId = parseInt(args[1].substring(3));
            if (referrerId && referrerId !== userId) {
                await processReferral(userId, referrerId);
            }
        }

        await addNewUser(userId, username);
        
        const mainMenu = Markup.keyboard([
            ['💫 Начать обработку', '💳 Купить кредиты'],
            ['💰 Баланс', '👥 Реферальная программа']
        ]).resize();
        
        await ctx.replyWithPhoto(
            { source: './assets/welcome.jpg' },
            {
                caption: 'Добро пожаловать! 👋\n\n' +
                        'Я помогу вам обработать изображения с помощью нейросети.\n' +
                        'У вас есть 1 бесплатный кредит для начала.\n\n' +
                        'Выберите действие в меню ниже:',
                reply_markup: mainMenu
            }
        );
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Обработчик кнопки "Начать обработку"
bot.hears('💫 Начать обработку', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            return ctx.reply(
                '❌ У вас закончились кредиты\n\n' +
                'Используйте команду 💳 Купить кредиты для пополнения баланса.',
                Markup.keyboard([
                    ['💳 Купить кредиты'],
                    ['💰 Баланс', '👥 Реферальная программа']
                ]).resize()
            );
        }

        await ctx.reply(
            '📸 Отправьте мне фотографию для обработки\n\n' +
            '⚠️ Важные правила:\n' +
            '1. Изображение должно содержать только людей старше 18 лет\n' +
            '2. Убедитесь, что на фото чётко видно лицо\n' +
            '3. Изображение должно быть хорошего качества',
            Markup.keyboard([
                ['❌ Отмена'],
                ['💰 Баланс', '👥 Реферальная программа']
            ]).resize()
        );
    } catch (error) {
        console.error('Ошибка при начале обработки:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработчик кнопки "Реферальная программа"
bot.hears('👥 Реферальная программа', async (ctx) => {
    try {
        const userId = ctx.from.id;
        
        // Получаем статистику рефералов
        const stats = await pool.query(
            'SELECT total_referrals, referral_earnings FROM users WHERE user_id = $1',
            [userId]
        );
        
        const referralLink = await createReferralLink(userId);
        
        await ctx.replyWithPhoto(
            { source: './assets/referral.jpg' },
            {
                caption: '🤝 Реферальная программа\n\n' +
                        '1️⃣ Пригласите друзей по вашей реферальной ссылке\n' +
                        '2️⃣ Получайте 50% от суммы их оплат\n\n' +
                        `📊 Ваша статистика:\n` +
                        `👥 Рефералов: ${stats.rows[0].total_referrals}\n` +
                        `💰 Заработано: ${stats.rows[0].referral_earnings.toFixed(2)} RUB\n\n` +
                        `🔗 Ваша реферальная ссылка:\n${referralLink}`,
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('♻️ Обновить статистику', 'refresh_referrals')]
                ])
            }
        );
    } catch (error) {
        console.error('Ошибка при показе реферальной программы:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработчик обновления статистики рефералов
bot.action('refresh_referrals', async (ctx) => {
    try {
        const userId = ctx.from?.id;
        if (!userId) {
            await ctx.answerCbQuery('Ошибка: пользователь не найден');
            return;
        }

        const stats = await pool.query(
            'SELECT total_referrals, referral_earnings FROM users WHERE user_id = $1',
            [userId]
        );
        
        const referralLink = await createReferralLink(userId);

        await ctx.answerCbQuery('Статистика обновлена!');
        await ctx.editMessageCaption(
            '🤝 Реферальная программа\n\n' +
            '1️⃣ Пригласите друзей по вашей реферальной ссылке\n' +
            '2️⃣ Получайте 50% от суммы их оплат\n\n' +
            `📊 Ваша статистика:\n` +
            `👥 Рефералов: ${stats.rows[0].total_referrals}\n` +
            `💰 Заработано: ${stats.rows[0].referral_earnings.toFixed(2)} RUB\n\n` +
            `🔗 Ваша реферальная ссылка:\n${referralLink}`,
            {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('♻️ Обновить статистику', 'refresh_referrals')]
                ])
            }
        );
    } catch (error) {
        console.error('Ошибка при обновлении статистики:', error);
        await ctx.answerCbQuery('Произошла ошибка при обновлении статистики');
    }
});

// Обработчик кнопки "Отмена"
bot.hears('❌ Отмена', async (ctx) => {
    const mainMenu = Markup.keyboard([
        ['💫 Начать обработку', '💳 Купить кредиты'],
        ['💰 Баланс', '👥 Реферальная программа']
    ]).resize();
    
    await ctx.reply('Операция отменена. Выберите действие:', mainMenu);
});

// Обработчик фотографий
bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    let processingMsg;
    
    try {
        const credits = await checkCredits(userId);

        if (credits <= 0) {
            return ctx.reply(
                '❌ У вас закончились кредиты\n\n' +
                'Используйте команду 💳 Купить кредиты для пополнения баланса.',
                Markup.keyboard([
                    ['💳 Купить кредиты'],
                    ['💰 Баланс', '👥 Реферальная программа']
                ]).resize()
            );
        }

        processingMsg = await ctx.reply(
            '⏳ Начинаю обработку изображения...\n' +
            'Пожалуйста, подождите.'
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
                Markup.keyboard([
                    ['💫 Начать обработку', '💳 Купить кредиты'],
                    ['💰 Баланс', '👥 Реферальная программа']
                ]).resize()
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
            Markup.keyboard([
                ['💫 Начать обработку', '💳 Купить кредиты'],
                ['💰 Баланс', '👥 Реферальная программа']
            ]).resize()
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

// Webhook handler для ClothOff
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
                    await bot.telegram.sendMessage(userId, errorMessage);
                    await returnCredit(userId);
                    await bot.telegram.sendMessage(userId, '💳 Кредит был возвращен из-за ошибки обработки.');
                    
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
                            reply_markup: Markup.keyboard([
                                ['💫 Начать обработку', '💳 Купить кредиты'],
                                ['💰 Баланс', '👥 Реферальная программа']
                            ]).resize()
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