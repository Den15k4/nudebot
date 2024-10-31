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

// Services
import { db } from './services/database';
import { imageProcessor } from './services/imageProcess';
import { initBroadcastService, broadcastService } from './services/broadcast';
import { initPaymentService, paymentService } from './services/payment';

// Utils
import { processPhotoMessage } from './utils/photoProcessor';

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
        headers: req.headers
    });
    next();
});

app.use(express.json());

// Применяем middleware для бота
bot.use(requireAcceptedRules);

// Основные команды
bot.command('start', commandHandlers.handleStart);
bot.command('credits', commandHandlers.handleCredits);
bot.command('buy', commandHandlers.handleBuy);
bot.command('help', commandHandlers.handleHelp);

// Команды админа
bot.command('admin', adminHandlers.handleAdminCommand);

// Обработчики меню
bot.hears(MENU_ACTIONS.VIEW_RULES, commandHandlers.handleRules);
bot.hears(MENU_ACTIONS.BACK, commandHandlers.handleBack);
bot.hears(MENU_ACTIONS.BUY_CREDITS, commandHandlers.handleBuy);
bot.hears(MENU_ACTIONS.CHECK_BALANCE, commandHandlers.handleCredits);
bot.hears(MENU_ACTIONS.HELP, commandHandlers.handleHelp);

// Админские действия
bot.hears(ADMIN_ACTIONS.BROADCAST, adminHandlers.handleBroadcastCommand);
bot.hears(ADMIN_ACTIONS.SCHEDULE, adminHandlers.handleScheduleCommand);
bot.hears(ADMIN_ACTIONS.STATS, adminHandlers.handleStats);
bot.hears(ADMIN_ACTIONS.CANCEL_BROADCAST, adminHandlers.handleCancelBroadcast);

// Обработка фотографий
bot.on('photo', processPhotoMessage);

// Express endpoints
app.get('/health', webhookHandlers.handleHealth);
app.post('/webhook', upload.any(), webhookHandlers.handleClothoffWebhook);
app.post('/rukassa/webhook', webhookHandlers.handleRukassaWebhook);
app.get('/payment/success', webhookHandlers.handlePaymentSuccess);
app.get('/payment/fail', webhookHandlers.handlePaymentFail);

// Функция запуска
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

// Обработка завершения работы
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    db.close();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    db.close();
});

// Запуск приложения
start();

// Для использования в других модулях
export default bot;