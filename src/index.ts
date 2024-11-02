import { Telegraf } from 'telegraf';
import express from 'express';
import multer from 'multer';

import { ENV } from './config/environment';
import { requireAcceptedRules } from './middlewares/auth';
import * as commandHandlers from './handlers/commands';
import * as adminHandlers from './handlers/admin';
import * as webhookHandlers from './handlers/webhooks';
import { handleCallbacks } from './handlers/callbacks';
import { processPhotoMessage } from './utils/photoProcess';

import { db } from './services/database';
import { initPaymentService } from './services/payment';

export const bot = new Telegraf(ENV.BOT_TOKEN);

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
        body: req.method === 'GET' ? undefined : req.body
    });
    next();
});

app.use(express.json());

bot.use(requireAcceptedRules);

// Команды
bot.command('start', commandHandlers.handleStart);
bot.command('credits', commandHandlers.handleCredits);
bot.command('buy', commandHandlers.handleBuy);
bot.command('help', commandHandlers.handleHelp);
bot.command('admin', adminHandlers.handleAdminCommand);
bot.command('referrals', commandHandlers.handleReferrals);

// Обработка callback'ов
bot.on('callback_query', handleCallbacks);

// Обработка фотографий
bot.on('photo', processPhotoMessage);

// Веб-хуки
app.post('/webhook', upload.any(), webhookHandlers.handleClothoffWebhook);
app.post('/rukassa/webhook', webhookHandlers.handleRukassaWebhook);
app.get('/health', webhookHandlers.handleHealth);

async function start() {
    try {
        await db.initTables();
        console.log('База данных инициализирована');

        initPaymentService(bot);
        console.log('Платежный сервис инициализирован');

        app.listen(ENV.PORT, '0.0.0.0', () => {
            console.log(`Webhook сервер запущен на порту ${ENV.PORT}`);
        });

        await bot.launch();
        console.log('Бот запущен');
    } catch (error) {
        console.error('Ошибка при запуске приложения:', error);
        setTimeout(() => process.exit(1), 1000);
    }
}

process.once('SIGINT', () => {
    bot.stop('SIGINT');
    db.close();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    db.close();
});

start();

export default bot;