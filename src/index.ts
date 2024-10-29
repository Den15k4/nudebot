import { Telegraf, Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { Update } from 'typegram';
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

        // Создание базовых таблиц
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id BIGINT PRIMARY KEY,
                username TEXT,
                credits INT DEFAULT 1,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                last_used TIMESTAMPTZ,
                pending_task_id TEXT,
                bot_id TEXT DEFAULT 'main'
            );

            CREATE TABLE IF NOT EXISTS bots (
                bot_id TEXT PRIMARY KEY,
                token TEXT NOT NULL,
                partner_id TEXT,
                status TEXT DEFAULT 'active',
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Добавление основного бота, если его нет
        await client.query(`
            INSERT INTO bots (bot_id, token) 
            VALUES ('main', $1) 
            ON CONFLICT (bot_id) DO NOTHING
        `, [BOT_TOKEN]);

        await client.query('COMMIT');
        console.log('База данных инициализирована успешно');
    } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof Error) {
            console.error('Ошибка при инициализации базы данных:', error.message);
        }
        throw error;
    } finally {
        client.release();
    }
}

// Функции работы с пользователями
async function checkCredits(userId: number, botId: string = 'main'): Promise<number> {
    try {
        const result = await pool.query(
            'SELECT credits FROM users WHERE user_id = $1 AND bot_id = $2',
            [userId, botId]
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
            'UPDATE users SET credits = credits - 1, last_used = CURRENT_TIMESTAMP WHERE user_id = $1 AND bot_id = $2',
            [userId, botId]
        );
    } catch (error) {
        console.error('Ошибка при использовании кредита:', error);
        throw error;
    }
}

async function returnCredit(userId: number, botId: string = 'main'): Promise<void> {
    try {
        await pool.query(
            'UPDATE users SET credits = credits + 1 WHERE user_id = $1 AND bot_id = $2',
            [userId, botId]
        );
    } catch (error) {
        console.error('Ошибка при возврате кредита:', error);
        throw error;
    }
}

async function addNewUser(userId: number, username: string | undefined, botId: string = 'main'): Promise<void> {
    try {
        await pool.query(
            'INSERT INTO users (user_id, username, bot_id, credits) VALUES ($1, $2, $3, 1) ON CONFLICT (user_id) DO NOTHING',
            [userId, username || 'anonymous', botId]
        );
    } catch (error) {
        console.error('Ошибка при добавлении пользователя:', error);
        throw error;
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
        console.log('Отправка запроса в API с полями:', {
            cloth: 'naked',
            id_gen,
            webhook: WEBHOOK_URL,
            hasImage: !!imageBuffer,
            botId
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
            'UPDATE users SET pending_task_id = $1 WHERE user_id = $2 AND bot_id = $3',
            [id_gen, userId, botId]
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
function setupBotHandlers(bot: Telegraf<Context<Update>>, botId: string = 'main') {
    bot.command('start', async (ctx: Context) => {
        try {
            const userId = ctx.from?.id;
            const username = ctx.from?.username;

            if (!userId) {
                return;
            }

            await addNewUser(userId, username, botId);
            
            await ctx.reply(
                'Привет! Я бот для обработки изображений.\n' +
                'У вас есть 1 бесплатный кредит.\n' +
                'Отправьте мне изображение, и я обработаю его.\n\n' +
                'Доступные команды:\n' +
                '/credits - проверить количество кредитов\n' +
                '/buy - купить дополнительные кредиты'
            );
        } catch (error) {
            console.error('Ошибка в команде start:', error);
            await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
        }
    });

    bot.command('credits', async (ctx: Context) => {
        try {
            const userId = ctx.from?.id;
            if (!userId) return;

            const credits = await checkCredits(userId, botId);
            await ctx.reply(`💳 У вас осталось кредитов: ${credits}`);
        } catch (error) {
            console.error('Ошибка при проверке кредитов:', error);
            await ctx.reply('Произошла ошибка при проверке кредитов. Попробуйте позже.');
        }
    });

    bot.on(message('photo'), async (ctx: Context<Update.MessageUpdate>) => {
        const userId = ctx.from?.id;
        if (!userId) return;

        let processingMsg;
        
        try {
            const credits = await checkCredits(userId, botId);

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
            const result = await processImage(imageBuffer, userId, botId);

            if (result.idGen) {
                await useCredit(userId, botId);
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
}

   // Настройка платежной системы для бота
   const rukassaPayment = new RukassaPayment(pool, bot, botId);
   rukassaPayment.initPaymentsTable();
   setupPaymentCommands(bot, pool, botId);
}

// Настройка webhook для обработки результатов
app.post('/webhook', upload.any(), async (req, res) => {
   try {
       console.log('Получен webhook запрос');
       console.log('Headers:', req.headers);
       console.log('Body:', req.body);
       console.log('Files:', req.files);

       const body = req.body as WebhookBody;
       const files = req.files as Express.Multer.File[] || [];

       // Извлекаем botId из id_gen (формат: botId_userId_timestamp)
       const botId = body.id_gen?.split('_')[0] || 'main';
       const bot = botId === 'main' ? mainBot : multiBotManager.getBot(botId);

       if (!bot) {
           throw new Error(`Бот ${botId} не найден`);
       }

       if (body.status === '500' || body.img_message || body.img_message_2) {
           console.log(`Ошибка обработки изображения: ${body.img_message || body.img_message_2}`);
           
           const userQuery = await pool.query(
               'SELECT user_id FROM users WHERE pending_task_id = $1 AND bot_id = $2',
               [body.id_gen, botId]
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
                   await returnCredit(userId, botId);
                   await bot.telegram.sendMessage(userId, '💳 Кредит был возвращен из-за ошибки обработки.');
                   
                   await pool.query(
                       'UPDATE users SET pending_task_id = NULL WHERE user_id = $1 AND bot_id = $2',
                       [userId, botId]
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
           'SELECT user_id FROM users WHERE pending_task_id = $1 AND bot_id = $2',
           [body.id_gen, botId]
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
                   'UPDATE users SET pending_task_id = NULL WHERE user_id = $1 AND bot_id = $2',
                   [userId, botId]
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
       setupBotHandlers(mainBot, 'main');
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