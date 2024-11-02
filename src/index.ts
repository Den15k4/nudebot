import { Telegraf } from 'telegraf';
import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import winston from 'winston';

import { ENV } from './config/environment';
import { requireAcceptedRules } from './middlewares/auth';
import * as commandHandlers from './handlers/commands';
import * as adminHandlers from './handlers/admin';
import * as webhookHandlers from './handlers/webhooks';
import { handleCallbacks } from './handlers/callbacks';
import { processPhotoMessage } from './utils/photoProcess';

import { db } from './services/database';
import { initPaymentService } from './services/payment';

// Настройка логгера
export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'telegram-bot' },
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

export const bot = new Telegraf(ENV.BOT_TOKEN);

const app = express();

// Настройка multer для загрузки файлов
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        files: 1
    }
});

// Настройка rate limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // максимум 100 запросов с одного IP
    message: 'Too many requests from this IP, please try again later.'
});

// Безопасность и middleware
app.use(helmet());
app.use(cors({
    origin: ENV.ALLOWED_ORIGINS || '*',
    methods: ['POST', 'GET']
}));
app.use(limiter);
app.use(express.json({ limit: '10mb' }));

// Логирование запросов
app.use((req, res, next) => {
    logger.info('Входящий запрос:', {
        method: req.method,
        path: req.path,
        headers: req.headers,
        query: req.query,
        body: req.method === 'GET' ? undefined : req.body
    });
    next();
});

// Обработка ошибок Express
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error('Express error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Настройка бота
bot.use(requireAcceptedRules);

// Команды бота
bot.command('start', async (ctx) => {
    try {
        await commandHandlers.handleStart(ctx);
    } catch (error) {
        logger.error('Error in start command:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

bot.command('credits', async (ctx) => {
    try {
        await commandHandlers.handleCredits(ctx);
    } catch (error) {
        logger.error('Error in credits command:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

bot.command('buy', async (ctx) => {
    try {
        await commandHandlers.handleBuy(ctx);
    } catch (error) {
        logger.error('Error in buy command:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

bot.command('help', async (ctx) => {
    try {
        await commandHandlers.handleHelp(ctx);
    } catch (error) {
        logger.error('Error in help command:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

bot.command('admin', async (ctx) => {
    try {
        await adminHandlers.handleAdminCommand(ctx);
    } catch (error) {
        logger.error('Error in admin command:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

bot.command('referrals', async (ctx) => {
    try {
        await commandHandlers.handleReferrals(ctx);
    } catch (error) {
        logger.error('Error in referrals command:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка callback'ов
bot.on('callback_query', async (ctx) => {
    try {
        await handleCallbacks(ctx);
    } catch (error) {
        logger.error('Error in callback handling:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.').catch(() => {});
    }
});

// Обработка фотографий
bot.on('photo', async (ctx) => {
    try {
        await processPhotoMessage(ctx);
    } catch (error) {
        logger.error('Error in photo processing:', error);
        await ctx.reply('Произошла ошибка при обработке фото. Попробуйте позже.');
    }
});

// Веб-хуки
app.post('/webhook', upload.any(), webhookHandlers.handleClothoffWebhook);
app.post('/rukassa/webhook', webhookHandlers.handleRukassaWebhook);
app.get('/health', webhookHandlers.handleHealth);

// Обработка необработанных ошибок
process.on('uncaughtException', (error) => {
    logger.error('Необработанное исключение:', error);
    // Отправка уведомления администраторам
    ENV.ADMIN_IDS.forEach(adminId => {
        bot.telegram.sendMessage(adminId, 
            `❌ Критическая ошибка:\n${error.message}\n\nStack:\n${error.stack}`
        ).catch(() => {});
    });
});

process.on('unhandledRejection', (reason: any, promise) => {
    logger.error('Необработанное отклонение промиса:', reason);
    // Отправка уведомления администраторам
    ENV.ADMIN_IDS.forEach(adminId => {
        bot.telegram.sendMessage(adminId, 
            `⚠️ Необработанное отклонение промиса:\n${reason}`
        ).catch(() => {});
    });
});

// Функция запуска
async function start() {
    try {
        await db.initTables();
        logger.info('База данных инициализирована');

        initPaymentService(bot);
        logger.info('Платежный сервис инициализирован');

        app.listen(ENV.PORT, '0.0.0.0', () => {
            logger.info(`Webhook сервер запущен на порту ${ENV.PORT}`);
        });

        await bot.launch();
        logger.info('Бот запущен');
    } catch (error) {
        logger.error('Ошибка при запуске приложения:', error);
        setTimeout(() => process.exit(1), 1000);
    }
}

// Graceful shutdown
process.once('SIGINT', () => {
    logger.info('Получен сигнал SIGINT');
    bot.stop('SIGINT');
    db.close();
});

process.once('SIGTERM', () => {
    logger.info('Получен сигнал SIGTERM');
    bot.stop('SIGTERM');
    db.close();
});

start();