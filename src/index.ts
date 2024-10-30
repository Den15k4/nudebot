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
const RULES_URL = 'https://telegra.ph/Pravila-ispolzovaniya-bota-03-27'; // Замените на реальный URL

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
                credits INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMPTZ,
                pending_task_id TEXT,
                accepted_rules BOOLEAN DEFAULT FALSE
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

// Функция проверки принятия правил
async function hasAcceptedRules(userId: number): Promise<boolean> {
    const result = await pool.query(
        'SELECT accepted_rules FROM users WHERE user_id = $1',
        [userId]
    );
    return result.rows[0]?.accepted_rules || false;
}

// Middleware для проверки принятия правил
async function requireAcceptedRules(ctx: any, next: () => Promise<void>) {
    if (ctx.message?.text === '/start') {
        return next();
    }

    const userId = ctx.from?.id;
    if (!userId) {
        return;
    }

    const accepted = await hasAcceptedRules(userId);
    if (!accepted) {
        await ctx.reply(
            '⚠️ Для использования бота необходимо принять правила.\n' +
            'Используйте команду /start для просмотра правил.'
        );
        return;
    }

    return next();
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
            const keyboard = Markup.inlineKeyboard([
                Markup.button.url('📜 Правила использования', RULES_URL),
                Markup.button.callback('✅ Принимаю правила', 'accept_rules')
            ]);

            await ctx.reply(
                '👋 Добро пожаловать!\n\n' +
                '🤖 Я бот для обработки изображений с использованием нейросети.\n\n' +
                '⚠️ Перед началом работы, пожалуйста:\n' +
                '1. Ознакомьтесь с правилами использования бота\n' +
                '2. Подтвердите своё согласие с правилами\n\n' +
                '❗️ Важно: использование бота возможно только после принятия правил.',
                keyboard
            );
        } else {
            await ctx.reply(
                '🤖 Добро пожаловать в бот для обработки изображений!\n\n' +
                'Для начала работы необходимо приобрести кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Доступные команды:\n' +
                '/credits - проверить баланс кредитов\n' +
                '/buy - приобрести кредиты'
            );
        }
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
});

// Обработчик принятия правил
bot.action('accept_rules', async (ctx) => {
    try {
        const userId = ctx.from?.id;
        if (!userId) {
            return;
        }

        await pool.query(
            'UPDATE users SET accepted_rules = TRUE WHERE user_id = $1',
            [userId]
        );

        await ctx.answerCbQuery('✅ Правила приняты');
        await ctx.editMessageText(
            '✅ Спасибо за принятие правил!\n\n' +
            '🤖 Теперь вы можете использовать бота.\n\n' +
            'Для начала работы необходимо приобрести кредиты:\n' +
            '1 кредит = 1 обработка изображения\n\n' +
            'Доступные команды:\n' +
            '/credits - проверить баланс кредитов\n' +
            '/buy - приобрести кредиты'
        );
    } catch (error) {
        console.error('Ошибка при принятии правил:', error);
        await ctx.answerCbQuery('❌ Произошла ошибка. Попробуйте позже.');
    }
});

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

bot.on(message('photo'), async (ctx) => {
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
                `🔄 ID задачи: ${result.idGen}\n\n` +'Результат будет отправлен, когда обработка завершится.'
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

        await ctx.reply(errorMessage);

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
                    await bot.telegram.sendPhoto(userId, { source: imageBuffer });
                    await bot.telegram.sendMessage(userId, '✨ Обработка изображения завершена!');
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