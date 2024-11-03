import { Telegraf } from 'telegraf';
import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import winston from 'winston';
import { emitWarning } from 'process';
import axios from 'axios';
import { message } from 'telegraf/filters';

// Отключаем предупреждение о punycode
emitWarning = (warning, ...args) => {
    if (warning.includes('The `punycode` module is deprecated')) {
        return;
    }
    return process.emitWarning(warning, ...args);
};

import { ENV } from './config/environment';
import { requireAcceptedRules } from './middlewares/auth';
import * as commandHandlers from './handlers/commands';
import * as adminHandlers from './handlers/admin';
import * as webhookHandlers from './handlers/webhooks';
import { handleCallbacks } from './handlers/callbacks';
import { processPhotoMessage } from './utils/photoProcess';
import { db } from './services/database';
import { initPaymentService } from './services/payment';
import { setupPaymentCommands, setupRukassaWebhook } from './services/rukassa';

// Настройка логгера
export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: 'telegram-bot' },
    transports: [
        new winston.transports.File({ 
            filename: 'logs/error.log', 
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        new winston.transports.File({ 
            filename: 'logs/combined.log',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Инициализация бота и Express
export const bot = new Telegraf(ENV.BOT_TOKEN);
const app = express();

// Настройка multer
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: ENV.MAX_FILE_SIZE,
        files: 1
    }
});

// Настройка rate limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
        },
    },
}));

app.use(cors({
    origin: ENV.ALLOWED_ORIGINS,
    methods: ['POST', 'GET'],
    credentials: true,
}));

app.use(limiter);
app.use(express.json({ limit: '10mb' }));

// Логирование запросов
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        logger.info('HTTP Request:', {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: Date.now() - startTime,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
    });
    next();
});

// Клавиатуры
const mainKeyboard = {
    inline_keyboard: [
        [
            { text: '📸 Обработать фото', callback_data: 'action_process_photo' },
            { text: '💳 Купить кредиты', callback_data: 'action_buy' }
        ],
        [
            { text: '💰 Баланс', callback_data: 'action_balance' },
            { text: '👥 Рефералы', callback_data: 'action_referrals' }
        ],
        [{ text: '❓ Помощь', callback_data: 'action_help' }]
    ]
};

// Обработчики команд
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const args = ctx.message.text.split(' ');
        const referralCode = args[1];

        if (referralCode) {
            try {
                // Декодируем реферальный код
                const referrerId = parseInt(Buffer.from(referralCode, 'base64').toString('ascii'));
                if (referrerId && referrerId !== userId) {
                    await db.addUser(userId, username, referrerId);
                    // Отправляем уведомление рефереру
                    const referrerStats = await db.getReferralStats(referrerId);
                    await ctx.telegram.sendMessage(
                        referrerId,
                        `🎉 По вашей реферальной ссылке присоединился новый пользователь!\n\n` +
                        `📊 Ваша статистика:\n` +
                        `• Приглашено: ${referrerStats.count} пользователей\n` +
                        `• Заработано: ${referrerStats.earnings}₽`
                    );
                } else {
                    await db.addUser(userId, username);
                }
            } catch (error) {
                logger.error('Ошибка при обработке реферального кода:', error);
                await db.addUser(userId, username);
            }
        } else {
            await db.addUser(userId, username);
        }

        const hasAcceptedRules = await db.hasAcceptedRules(userId);
        if (!hasAcceptedRules) {
            await ctx.reply(
                '👋 Добро пожаловать!\n\n' +
                '⚠️ Перед началом работы ознакомьтесь с правилами использования бота:\n\n' +
                '1️⃣ Бот предназначен только для лиц старше 18 лет\n' +
                '2️⃣ Запрещено использование изображений несовершеннолетних\n' +
                '3️⃣ Запрещена обработка изображений, содержащих насилие\n' +
                '4️⃣ Пользователь несет ответственность за загружаемый контент\n\n' +
                '❗️ Чтобы начать работу, примите правила использования.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Принимаю правила', callback_data: 'action_accept_rules' }]
                        ]
                    }
                }
            );
        } else {
            const credits = await db.checkCredits(userId);
            await ctx.reply(
                `👋 С возвращением!\n\n` +
                `💳 У вас ${credits} кредитов\n\n` +
                `📸 Отправьте фото для обработки или воспользуйтесь меню:`,
                { reply_markup: mainKeyboard }
            );
        }
    } catch (error) {
        logger.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка реферальных действий
bot.action('action_referrals', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const referralCode = Buffer.from(userId.toString()).toString('base64');
        const stats = await db.getReferralStats(userId);
        const withdrawals = await db.getReferralWithdrawals(userId);

        let message = `👥 Ваша реферальная программа:\n\n` +
            `🔗 Ваша ссылка для приглашения:\n` +
            `https://t.me/${ctx.botInfo.username}?start=${referralCode}\n\n` +
            `📊 Статистика:\n` +
            `• Приглашено: ${stats.count} пользователей\n` +
            `• Заработано всего: ${stats.earnings}₽\n\n` +
            `💰 Доступно к выводу: ${stats.earnings}₽\n\n` +
            `ℹ️ Вы получаете 50% от каждого платежа реферала\n` +
            `💎 Минимальная сумма для вывода: 100₽`;

        if (withdrawals.length > 0) {
            message += '\n\n📝 Последние операции:\n';
            withdrawals.forEach((w, i) => {
                message += `${i + 1}. ${w.amount}₽ - ${w.status === 'completed' ? '✅' : '⏳'}\n`;
            });
        }

        await ctx.editMessageText(message, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💰 Вывести средства', callback_data: 'action_withdraw' }],
                    [{ text: '◀️ Назад', callback_data: 'action_back' }]
                ]
            },
            parse_mode: 'HTML'
        });
    } catch (error) {
        logger.error('Ошибка при показе реферальной статистики:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка вывода средств
bot.action('action_withdraw', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const stats = await db.getReferralStats(userId);

        if (stats.earnings < 100) {
            await ctx.answerCbQuery('Минимальная сумма для вывода: 100₽');
            return;
        }

        await ctx.editMessageText(
            '💳 Выберите способ вывода средств:\n\n' +
            `Доступно: ${stats.earnings}₽`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Банковская карта', callback_data: 'withdraw_card' }],
                        [{ text: '💎 USDT (TRC20)', callback_data: 'withdraw_crypto' }],
                        [{ text: '◀️ Назад', callback_data: 'action_referrals' }]
                    ]
                }
            }
        );
    } catch (error) {
        logger.error('Ошибка при выводе средств:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});
// Обработчики команд
bot.command('start', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const username = ctx.from.username;
        const args = ctx.message.text.split(' ');
        const referralCode = args[1];

        if (referralCode) {
            try {
                // Декодируем реферальный код
                const referrerId = parseInt(Buffer.from(referralCode, 'base64').toString('ascii'));
                if (referrerId && referrerId !== userId) {
                    await db.addUser(userId, username, referrerId);
                    // Отправляем уведомление рефереру
                    const referrerStats = await db.getReferralStats(referrerId);
                    await ctx.telegram.sendMessage(
                        referrerId,
                        `🎉 По вашей реферальной ссылке присоединился новый пользователь!\n\n` +
                        `📊 Ваша статистика:\n` +
                        `• Приглашено: ${referrerStats.count} пользователей\n` +
                        `• Заработано: ${referrerStats.earnings}₽`
                    );
                } else {
                    await db.addUser(userId, username);
                }
            } catch (error) {
                logger.error('Ошибка при обработке реферального кода:', error);
                await db.addUser(userId, username);
            }
        } else {
            await db.addUser(userId, username);
        }

        const hasAcceptedRules = await db.hasAcceptedRules(userId);
        if (!hasAcceptedRules) {
            await ctx.reply(
                '👋 Добро пожаловать!\n\n' +
                '⚠️ Перед началом работы ознакомьтесь с правилами использования бота:\n\n' +
                '1️⃣ Бот предназначен только для лиц старше 18 лет\n' +
                '2️⃣ Запрещено использование изображений несовершеннолетних\n' +
                '3️⃣ Запрещена обработка изображений, содержащих насилие\n' +
                '4️⃣ Пользователь несет ответственность за загружаемый контент\n\n' +
                '❗️ Чтобы начать работу, примите правила использования.',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Принимаю правила', callback_data: 'action_accept_rules' }]
                        ]
                    }
                }
            );
        } else {
            const credits = await db.checkCredits(userId);
            await ctx.reply(
                `👋 С возвращением!\n\n` +
                `💳 У вас ${credits} кредитов\n\n` +
                `📸 Отправьте фото для обработки или воспользуйтесь меню:`,
                { reply_markup: mainKeyboard }
            );
        }
    } catch (error) {
        logger.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка реферальных действий
bot.action('action_referrals', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const referralCode = Buffer.from(userId.toString()).toString('base64');
        const stats = await db.getReferralStats(userId);
        const withdrawals = await db.getReferralWithdrawals(userId);

        let message = `👥 Ваша реферальная программа:\n\n` +
            `🔗 Ваша ссылка для приглашения:\n` +
            `https://t.me/${ctx.botInfo.username}?start=${referralCode}\n\n` +
            `📊 Статистика:\n` +
            `• Приглашено: ${stats.count} пользователей\n` +
            `• Заработано всего: ${stats.earnings}₽\n\n` +
            `💰 Доступно к выводу: ${stats.earnings}₽\n\n` +
            `ℹ️ Вы получаете 50% от каждого платежа реферала\n` +
            `💎 Минимальная сумма для вывода: 100₽`;

        if (withdrawals.length > 0) {
            message += '\n\n📝 Последние операции:\n';
            withdrawals.forEach((w, i) => {
                message += `${i + 1}. ${w.amount}₽ - ${w.status === 'completed' ? '✅' : '⏳'}\n`;
            });
        }

        await ctx.editMessageText(message, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💰 Вывести средства', callback_data: 'action_withdraw' }],
                    [{ text: '◀️ Назад', callback_data: 'action_back' }]
                ]
            },
            parse_mode: 'HTML'
        });
    } catch (error) {
        logger.error('Ошибка при показе реферальной статистики:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка вывода средств
bot.action('action_withdraw', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const stats = await db.getReferralStats(userId);

        if (stats.earnings < 100) {
            await ctx.answerCbQuery('Минимальная сумма для вывода: 100₽');
            return;
        }

        await ctx.editMessageText(
            '💳 Выберите способ вывода средств:\n\n' +
            `Доступно: ${stats.earnings}₽`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Банковская карта', callback_data: 'withdraw_card' }],
                        [{ text: '💎 USDT (TRC20)', callback_data: 'withdraw_crypto' }],
                        [{ text: '◀️ Назад', callback_data: 'action_referrals' }]
                    ]
                }
            }
        );
    } catch (error) {
        logger.error('Ошибка при выводе средств:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка фотографий
bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    let processingMsg;
    
    try {
        const credits = await db.checkCredits(userId);

        if (credits <= 0) {
            await sendMessage(ctx, 
                '❌ У вас недостаточно кредитов\n\n' +
                '💳 Купите кредиты, чтобы продолжить обработку фотографий',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 Купить кредиты', callback_data: 'action_buy' }],
                            [{ text: '◀️ В главное меню', callback_data: 'action_back' }]
                        ]
                    }
                }
            );
            return;
        }

        await sendMessage(
            ctx,
            '⚠️ Важные правила:\n\n' +
            '1. Изображение должно содержать только людей старше 18 лет\n' +
            '2. Убедитесь, что на фото чётко видно лицо\n' +
            '3. Изображение должно быть хорошего качества\n\n' +
            '⏳ Начинаю обработку...'
        );

        processingMsg = await ctx.reply('⌛️ Обрабатываю изображение, пожалуйста, подождите...');

        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.telegram.getFile(photo.file_id);
        
        if (!file.file_path) {
            throw new Error('Не удалось получить путь к файлу');
        }

        const imageResponse = await axios.get(
            `https://api.telegram.org/file/bot${ENV.BOT_TOKEN}/${file.file_path}`,
            { responseType: 'arraybuffer' }
        );

        const imageBuffer = Buffer.from(imageResponse.data);
        const startTime = Date.now();

        try {
            const result = await imageProcessor.processImage(imageBuffer, userId);

            if (result.idGen) {
                await db.updateUserCredits(userId, -1);
                await sendMessage(
                    ctx,
                    '✅ Изображение принято на обработку:\n' +
                    `🕒 Время в очереди: ${result.queueTime} сек\n` +
                    `📊 Позиция в очереди: ${result.queueNum}\n` +
                    `🔄 ID задачи: ${result.idGen}\n\n` +
                    'Результат будет отправлен, когда обработка завершится.',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '❌ Отменить обработку', callback_data: 'action_cancel_processing' }],
                                [{ text: '◀️ В главное меню', callback_data: 'action_back' }]
                            ]
                        }
                    }
                );

                const processingTime = Date.now() - startTime;
                await db.updatePhotoProcessingStats(
                    userId, 
                    true, 
                    undefined, 
                    processingTime,
                    imageBuffer.length
                );
            }

        } catch (error) {
            const processingTime = Date.now() - startTime;
            await db.updatePhotoProcessingStats(
                userId,
                false,
                error instanceof Error ? error.message : 'Unknown error',
                processingTime,
                imageBuffer.length
            );
            throw error;
        }

    } catch (error) {
        let errorMessage = '❌ Произошла ошибка при обработке изображения.';
        
        if (error instanceof Error) {
            logger.error('Ошибка при обработке изображения:', error);
            
            switch (error.message) {
                case 'AGE_RESTRICTION':
                    errorMessage = '🔞 Обработка запрещена: На изображении обнаружен человек младше 18 лет.';
                    break;
                case 'INSUFFICIENT_BALANCE':
                    errorMessage = '⚠️ Сервис временно недоступен. Попробуйте позже.';
                    break;
                default:
                    errorMessage += `\n${error.message}`;
            }
        }

        await sendMessage(
            ctx,
            errorMessage,
            { reply_markup: mainKeyboard }
        );
    } finally {
        if (processingMsg?.message_id) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }
    }
});

// Обработка платежей
bot.action(/^currency_(.+)$/, async (ctx) => {
    try {
        const currency = ctx.match[1] as SupportedCurrency;
        const packages = paymentService.getAvailablePackages(currency);

        if (packages.length === 0) {
            await ctx.answerCbQuery('В данной валюте пакеты временно недоступны');
            return;
        }

        const buttons = packages.map(pkg => [{
            text: `${pkg.description} - ${pkg.prices[currency]} ${currency}`,
            callback_data: `buy_${pkg.id}_${currency}`
        }]);

        buttons.push([{ text: '◀️ Назад', callback_data: 'action_back' }]);

        await ctx.editMessageText(
            `💳 Выберите пакет кредитов:`,
            { reply_markup: { inline_keyboard: buttons } }
        );
    } catch (error) {
        logger.error('Ошибка при выборе валюты:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

bot.action(/^buy_(\d+)_(.+)$/, async (ctx) => {
    try {
        const packageId = parseInt(ctx.match[1]);
        const currency = ctx.match[2] as SupportedCurrency;
        const userId = ctx.from.id;

        const paymentUrl = await paymentService.createPayment(userId, packageId, currency);

        await ctx.editMessageText(
            '💳 Оплата\n\n' +
            'Для оплаты перейдите по кнопке ниже.\n' +
            'После успешной оплаты кредиты будут начислены автоматически.',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Перейти к оплате', url: paymentUrl }],
                        [{ text: '◀️ Назад к выбору пакета', callback_data: `currency_${currency}` }]
                    ]
                }
            }
        );
    } catch (error) {
        logger.error('Ошибка при создании платежа:', error);
        await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
    }
});

// Обработчики вебхуков
app.post('/webhook', upload.any(), async (req, res) => {
    try {
        logger.info('Получен webhook от ClothOff:', {
            body: req.body,
            files: req.files
        });

        const body = req.body;
        const files = req.files as Express.Multer.File[] || [];

        // Проверяем наличие id_gen
        if (!body.id_gen) {
            logger.error('Отсутствует id_gen в запросе');
            return res.status(400).json({ error: 'Missing id_gen' });
        }

        const user = await db.getUserByPendingTask(body.id_gen);
        if (!user) {
            logger.error('Пользователь не найден для задачи:', body.id_gen);
            return res.status(404).json({ error: 'User not found' });
        }

        // Обработка ошибок
        if (body.status === '500' || body.img_message || body.img_message_2) {
            let errorMessage = '❌ Не удалось обработать изображение:\n\n';
            let isAgeRestriction = false;

            if (body.img_message?.toLowerCase().includes('age is too young') || 
                body.img_message_2?.toLowerCase().includes('age is too young')) {
                errorMessage = '🔞 На изображении обнаружен человек младше 18 лет.\n' +
                             'Обработка таких изображений запрещена.';
                isAgeRestriction = true;
            } else {
                errorMessage += body.img_message || body.img_message_2 || 'Неизвестная ошибка';
            }

            try {
                await Promise.all([
                    bot.telegram.sendMessage(user.user_id, errorMessage, { reply_markup: mainKeyboard }),
                    db.updateUserCredits(user.user_id, 1), // Возврат кредита
                    db.setUserPendingTask(user.user_id, null),
                    db.updatePhotoProcessingStats(user.user_id, false, errorMessage)
                ]);

                logger.info('Обработка ошибки завершена:', {
                    userId: user.user_id,
                    isAgeRestriction,
                    errorMessage
                });
            } catch (error) {
                logger.error('Ошибка при обработке ошибки:', error);
            }

            return res.json({ success: true });
        }

        // Обработка успешного результата
        if (body.result || files.length > 0) {
            try {
                let imageBuffer: Buffer | undefined;
                
                if (body.result) {
                    imageBuffer = Buffer.from(body.result, 'base64');
                } else if (files.length > 0) {
                    imageBuffer = files[0].buffer;
                }

                if (imageBuffer) {
                    await Promise.all([
                        bot.telegram.sendPhoto(
                            user.user_id,
                            { source: imageBuffer },
                            { 
                                caption: '✨ Обработка изображения завершена!\n\n' +
                                        'Используйте кнопки ниже для следующего действия:',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '📸 Обработать ещё', callback_data: 'action_process_photo' }],
                                        [{ text: '◀️ В главное меню', callback_data: 'action_back' }]
                                    ]
                                }
                            }
                        ),
                        db.updatePhotoProcessingStats(user.user_id, true),
                        db.setUserPendingTask(user.user_id, null)
                    ]);

                    logger.info('Результат успешно отправлен:', {
                        userId: user.user_id,
                        taskId: body.id_gen
                    });
                }
            } catch (error) {
                logger.error('Ошибка при отправке результата:', error);
                throw error;
            }
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('Ошибка обработки webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Вебхук для платежной системы
app.post('/rukassa/webhook', express.json(), async (req, res) => {
    try {
        logger.info('Получен webhook от Rukassa:', req.body);
        
        const data = req.body;
        
        // Проверка подписи
        const signature = generateSignature(data); // Реализация функции генерации подписи
        if (signature !== data.sign) {
            logger.error('Неверная подпись webhook');
            return res.status(400).json({ error: 'Invalid signature' });
        }

        if (!data.merchant_order_id || !data.payment_status) {
            logger.error('Отсутствуют обязательные поля в webhook');
            return res.status(400).json({ error: 'Missing required fields' });
        }

        await paymentService.handleWebhook(data);
        
        return res.json({ success: true });
    } catch (error) {
        logger.error('Ошибка обработки webhook Rukassa:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Проверка здоровья сервиса
app.get('/health', async (req, res) => {
    try {
        // Проверка подключения к БД
        const dbHealthy = await db.healthCheck();
        
        res.json({
            status: 'ok',
            database: dbHealthy ? 'connected' : 'error',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage()
        });
    } catch (error) {
        logger.error('Ошибка в health check:', error);
        res.status(500).json({ 
            status: 'error',
            timestamp: new Date().toISOString(),
            error: 'Service health check failed'
        });
    }
});

// Функция запуска
let server: any;

async function start() {
    try {
        // Инициализация базы данных
        await db.initTables();
        logger.info('База данных инициализирована');

        // Инициализация платежного сервиса
        initPaymentService(bot);
        logger.info('Платежный сервис инициализирован');

        // Запуск HTTP сервера
        server = app.listen(ENV.PORT, '0.0.0.0', () => {
            logger.info(`Webhook сервер запущен на порту ${ENV.PORT}`);
        });

        // Запуск бота
        await bot.launch();
        logger.info('Бот запущен');

    } catch (error) {
        logger.error('Ошибка при запуске приложения:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
        process.exit(1);
    }
}

// Graceful shutdown
async function shutdown(signal: string) {
    logger.info(`Получен сигнал ${signal}, начинаем graceful shutdown`);
    
    try {
        // Останавливаем приём новых запросов
        if (server) {
            await new Promise((resolve) => {
                server.close(resolve);
            });
            logger.info('HTTP сервер остановлен');
        }

        // Останавливаем бота
        await bot.stop();
        logger.info('Бот остановлен');

        // Закрываем соединение с БД
        await db.close();
        logger.info('Соединение с БД закрыто');

        logger.info('Приложение успешно остановлено');
        
        // Даем время на запись логов
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        process.exit(0);
    } catch (error) {
        logger.error('Ошибка при остановке приложения:', error);
        process.exit(1);
    }
}

// Обработка сигналов завершения
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Глобальная обработка необработанных ошибок
process.on('uncaughtException', (error) => {
    logger.error('Необработанное исключение:', {
        error: error.message,
        stack: error.stack
    });
    
    // Отправка уведомления администраторам
    ENV.ADMIN_IDS.forEach(adminId => {
        bot.telegram.sendMessage(
            adminId, 
            `❌ Критическая ошибка:\n${error.message}\n\nStack:\n${error.stack}`
        ).catch(() => {});
    });
});

process.on('unhandledRejection', (reason: any) => {
    logger.error('Необработанное отклонение промиса:', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined
    });
    
    // Отправка уведомления администраторам
    ENV.ADMIN_IDS.forEach(adminId => {
        bot.telegram.sendMessage(
            adminId, 
            `⚠️ Необработанное отклонение промиса:\n${reason}`
        ).catch(() => {});
    });
});

// Запуск приложения
start();