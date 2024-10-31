import { Telegraf } from 'telegraf';
import express from 'express';
import multer from 'multer';

// Конфигурация
import { ENV } from './config/environment';
import { MENU_ACTIONS, ADMIN_ACTIONS } from './config/constants';

// Middleware
import { requireAcceptedRules } from './middlewares/auth';

// Handlers
import * as commandHandlers from './handlers/commands';
import * as adminHandlers from './handlers/admin';
import * as webhookHandlers from './handlers/webhooks';
import { handleCallbacks } from './handlers/callbacks';
import { processPhotoMessage } from './utils/photoProcess';

// Services
import { db } from './services/database';
import { imageProcessor } from './services/imageProcess';
import { initBroadcastService, broadcastService } from './services/broadcast';
import { initPaymentService, paymentService } from './services/payment';

// Инициализация бота
export const bot = new Telegraf(ENV.BOT_TOKEN);

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
        headers: req.headers,
        query: req.query,
        body: req.method === 'GET' ? undefined : req.body
    });
    next();
});

app.use(express.json());

// Применяем middleware
bot.use(requireAcceptedRules);

// Обработчики команд
bot.command('start', commandHandlers.handleStart);
bot.command('credits', commandHandlers.handleCredits);
bot.command('buy', commandHandlers.handleBuy);
bot.command('help', commandHandlers.handleHelp);
bot.command('admin', adminHandlers.handleAdminCommand);
bot.command('referrals', commandHandlers.handleReferrals);

// Обработчик callback'ов (inline кнопок)
bot.on('callback_query', handleCallbacks);

// Обработка фотографий
bot.on('photo', processPhotoMessage);

// Express endpoints
app.get('/health', webhookHandlers.handleHealth);
app.post('/', upload.any(), webhookHandlers.handleClothoffWebhook);  // Добавлен корневой путь
app.post('/webhook', upload.any(), webhookHandlers.handleClothoffWebhook);
app.post('/rukassa/webhook', webhookHandlers.handleRukassaWebhook);
app.get('/payment/success', webhookHandlers.handlePaymentSuccess);
app.get('/payment/fail', webhookHandlers.handlePaymentFail);

// Запуск приложения
async function start() {
    try {
        // Инициализация базы данных
        await db.initTables();
        console.log('База данных инициализирована');

        // Инициализация сервисов
        initBroadcastService(bot);
        initPaymentService(bot);
        console.log('Сервисы инициализированы');

        // Восстановление отложенных рассылок
        await broadcastService.restoreScheduledBroadcasts();
        console.log('Отложенные рассылки восстановлены');

        // Запуск веб-сервера
        app.listen(ENV.PORT, '0.0.0.0', () => {
            console.log(`Webhook сервер запущен на порту ${ENV.PORT}`);
        });

        // Запуск бота
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
    db.close();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    db.close();
});

start();

// Для использования в других модулях
export default bot;