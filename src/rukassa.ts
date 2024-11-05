import { Telegraf } from 'telegraf';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';
import crypto from 'crypto';

// Основные конфигурационные параметры
const SHOP_ID = process.env.SHOP_ID || '2660';
const TOKEN = process.env.TOKEN || '9876a82910927a2c9a43f34cb5ad2de7';
const RUKASSA_API_URL = 'https://lk.rukassa.pro/api/v1/create';
const WEBHOOK_URL = process.env.WEBHOOK_URL?.replace('/webhook', '') || 'https://nudebot-production.up.railway.app';

// Курсы валют к рублю
const CURRENCY_RATES = {
    RUB: 1,
    KZT: 5,        // 1 рубль ≈ 5 тенге
    UZS: 140,      // 1 рубль ≈ 140 сумов
};

// Интерфейсы
interface RukassaCreatePaymentResponse {
    id?: number;
    hash?: string;
    url?: string;
    link?: string;
    status?: boolean;
    error?: string;
    message?: string;
    order_id?: string;
}

interface RukassaWebhookBody {
    shop_id: string;
    amount: string;
    order_id: string;
    payment_status: string;
    payment_method: string;
    custom_fields: string;
    merchant_order_id: string;
    sign: string;
    status?: string;
    currency?: string;
    description?: string;
    test?: boolean;
}

interface RukassaNewWebhookBody {
    id: string;
    order_id: string;
    amount: string;
    in_amount: string;
    data: string;
    createdDateTime: string;
    status: string;
}

interface Price {
    [key: string]: number;
    RUB: number;
    KZT: number;
    UZS: number;
}

type SupportedCurrency = 'RUB' | 'KZT' | 'UZS';

interface Currency {
    code: SupportedCurrency;
    symbol: string;
    name: string;
    method: string;
    minAmount: number;
}

interface PaymentPackage {
    id: number;
    credits: number;
    prices: Price;
    description: string;
}

// Поддерживаемые валюты
const SUPPORTED_CURRENCIES: Currency[] = [
    { 
        code: 'RUB', 
        symbol: '₽', 
        name: 'Visa/MC (RUB)', 
        method: 'card',
        minAmount: 500
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Visa/MC (KZT)', 
        method: 'card_kzt',
        minAmount: 2500
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Visa/MC (UZS)', 
        method: 'card_uzs',
        minAmount: 70000
    }
];

// Функция для конвертации цен в другие валюты
function convertPrice(rubPrice: number, currency: SupportedCurrency): number {
    return Math.round(rubPrice * CURRENCY_RATES[currency]);
}

// Пакеты с ценами
const CREDIT_PACKAGES: PaymentPackage[] = [
    {
        id: 1,
        credits: 4,
        prices: {
            RUB: 500,
            KZT: convertPrice(500, 'KZT'),
            UZS: convertPrice(500, 'UZS'),
        },
        description: '4 генерации'
    },
    {
        id: 2,
        credits: 8,
        prices: {
            RUB: 700,
            KZT: convertPrice(700, 'KZT'),
            UZS: convertPrice(700, 'UZS'),
        },
        description: '8 генераций'
    },
    {
        id: 3,
        credits: 16,
        prices: {
            RUB: 1120,
            KZT: convertPrice(1120, 'KZT'),
            UZS: convertPrice(1120, 'UZS'),
        },
        description: '16 генераций'
    },
    {
        id: 4,
        credits: 50,
        prices: {
            RUB: 2500,
            KZT: convertPrice(2500, 'KZT'),
            UZS: convertPrice(2500, 'UZS'),
        },
        description: '50 генераций'
    }
];

// Интерфейс для обработчика реферальных платежей
interface ReferralPaymentHandler {
    processReferralPayment: (userId: number, amount: number) => Promise<void>;
}
export class RukassaPayment {
    private pool: Pool;
    private bot: Telegraf;
    private referralHandler?: ReferralPaymentHandler;

    constructor(pool: Pool, bot: Telegraf, referralHandler?: ReferralPaymentHandler) {
        this.pool = pool;
        this.bot = bot;
        this.referralHandler = referralHandler;
    }

    async initPaymentsTable(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            const tableExists = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'payments'
                );
            `);

            if (!tableExists.rows[0].exists) {
                await client.query(`
                    CREATE TABLE payments (
                        id SERIAL PRIMARY KEY,
                        user_id BIGINT REFERENCES users(user_id),
                        order_id TEXT UNIQUE,
                        merchant_order_id TEXT UNIQUE,
                        amount DECIMAL,
                        credits INTEGER,
                        status TEXT,
                        currency TEXT,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    );

                    CREATE INDEX idx_payments_user_id ON payments(user_id);
                    CREATE INDEX idx_payments_merchant_order_id ON payments(merchant_order_id);
                    CREATE INDEX idx_payments_status ON payments(status);
                `);
            }

            await client.query('COMMIT');
            console.log('Таблица payments проверена и готова к работе');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Ошибка при инициализации таблицы payments:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async cleanupStalePayment(userId: number): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            const pendingPayment = await client.query(
                `SELECT merchant_order_id, created_at 
                 FROM payments 
                 WHERE user_id = $1 AND status = 'pending'
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [userId]
            );

            if (pendingPayment.rows.length > 0) {
                const { merchant_order_id, created_at } = pendingPayment.rows[0];
                const paymentAge = Date.now() - created_at.getTime();
                
                if (paymentAge > 30 * 60 * 1000) {
                    await client.query(
                        `UPDATE payments 
                         SET status = 'expired', updated_at = CURRENT_TIMESTAMP 
                         WHERE merchant_order_id = $1`,
                        [merchant_order_id]
                    );
                    
                    console.log(`Платёж ${merchant_order_id} помечен как устаревший`);
                } else {
                    throw new Error('У вас уже есть незавершенный платеж');
                }
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    private validateSignature(data: RukassaWebhookBody): boolean {
        const signString = `${data.shop_id}:${data.amount}:${data.order_id}:${TOKEN}`;
        const calculatedSign = crypto.createHash('md5').update(signString).digest('hex');
        return calculatedSign === data.sign;
    }

    async createPayment(userId: number, packageId: number, currency: SupportedCurrency = 'RUB'): Promise<string> {
        const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
        if (!package_) {
            throw new Error('Неверный ID пакета');
        }

        const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
        if (!curr) {
            throw new Error('Неподдерживаемая валюта');
        }

        await this.cleanupStalePayment(userId);

        const merchantOrderId = `${userId}_${Date.now()}`;
        
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, merchantOrderId, package_.prices[currency], package_.credits, 'pending', currency]
            );

            // Создаем объект данных для отправки
            const paymentData = {
                shop_id: SHOP_ID,
                token: TOKEN,
                order_id: merchantOrderId,
                amount: package_.prices[currency].toString(),
                method: curr.method,
                currency_in: currency,
                webhook_url: `${WEBHOOK_URL}/rukassa/webhook`,
                success_url: `${WEBHOOK_URL}/payment/success`,
                fail_url: `${WEBHOOK_URL}/payment/fail`,
                back_url: `${WEBHOOK_URL}/payment/back`,
                user_code: userId.toString(), // Убедимся что user_code передается как строка
                custom_fields: JSON.stringify({
                    user_id: userId,
                    package_id: packageId,
                    credits: package_.credits,
                    original_amount: package_.prices[currency],
                    original_currency: currency,
                    description: `${package_.description} для пользователя ${userId}`
                })
            };

            console.log('Отправка запроса на создание платежа:', {
                merchantOrderId,
                userId,
                amount: package_.prices[currency],
                currency,
                webhook_url: `${WEBHOOK_URL}/rukassa/webhook`,
                paymentData
            });

            // Создаем FormData для отправки
            const formData = new URLSearchParams();
            Object.entries(paymentData).forEach(([key, value]) => {
                formData.append(key, value);
            });

            const response = await axios.post<RukassaCreatePaymentResponse>(
                RUKASSA_API_URL,
                formData,
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: 10000
                }
            );

            console.log('Ответ от RuKassa:', response.data);

            if (response.data.error) {
                throw new Error(response.data.message || response.data.error);
            }

            const paymentUrl = response.data.url || response.data.link;
            if (!paymentUrl) {
                throw new Error('Не удалось получить ссылку на оплату');
            }

            await client.query('COMMIT');
            return paymentUrl;

        } catch (error) {
            await client.query('ROLLBACK');
            if (axios.isAxiosError(error)) {
                console.error('Ошибка axios:', error.response?.data);
                throw new Error(`Ошибка оплаты: ${error.response?.data?.message || error.response?.data?.error || 'Сервис временно недоступен'}`);
            }
            throw error;
        } finally {
            client.release();
        }
    }
    async checkPaymentStatus(orderId: string): Promise<string> {
        try {
            const formData = new URLSearchParams();
            formData.append('shop_id', SHOP_ID);
            formData.append('token', TOKEN);
            formData.append('order_id', orderId);

            const response = await axios.post(
                'https://lk.rukassa.pro/api/v1/check',
                formData,
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            return response.data?.status || 'unknown';
        } catch (error) {
            console.error('Ошибка при проверке статуса платежа:', error);
            return 'error';
        }
    }

    async handleWebhook(webhookBody: RukassaWebhookBody | RukassaNewWebhookBody): Promise<void> {
        console.log('Получены данные webhook:', webhookBody);

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Определяем merchant_order_id в зависимости от формата вебхука
            const merchant_order_id = 'merchant_order_id' in webhookBody ? 
                webhookBody.merchant_order_id : 
                webhookBody.order_id;

            const paymentResult = await client.query(
                `SELECT p.user_id, p.credits, p.currency, p.amount, p.status as current_status, u.credits as user_current_credits
                 FROM payments p
                 JOIN users u ON u.user_id = p.user_id
                 WHERE p.merchant_order_id = $1`,
                [merchant_order_id]
            );

            if (paymentResult.rows.length === 0) {
                throw new Error(`Платёж ${merchant_order_id} не найден`);
            }

            const { user_id, credits, currency, amount, current_status, user_current_credits } = paymentResult.rows[0];

            if (current_status === 'paid') {
                console.log(`Платеж ${merchant_order_id} уже был обработан ранее`);
                await client.query('COMMIT');
                return;
            }

            // Определяем статус платежа
            const payment_status = 'status' in webhookBody ? 
                (webhookBody.status === 'PAID' ? 'paid' : 'failed') :
                webhookBody.payment_status;

            console.log(`Обработка платежа ${merchant_order_id}, статус: ${payment_status}`);

            // Обновляем статус платежа
            await client.query(
                'UPDATE payments SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE merchant_order_id = $3',
                [payment_status, 'id' in webhookBody ? webhookBody.id : webhookBody.order_id, merchant_order_id]
            );

            if (payment_status === 'paid') {
                console.log(`Начисление ${credits} кредитов пользователю ${user_id}. Текущий баланс: ${user_current_credits}`);
                
                // Начисляем кредиты
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [credits, user_id]
                );

                // Обрабатываем реферальную программу
                const amountInRub = parseFloat('amount' in webhookBody ? webhookBody.amount : amount.toString());
                if (!isNaN(amountInRub) && this.referralHandler) {
                    try {
                        await this.referralHandler.processReferralPayment(user_id, amountInRub);
                    } catch (error) {
                        console.error('Ошибка при обработке реферального платежа:', error);
                    }
                }

                // Отправляем уведомление пользователю
                const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата ${amount} ${curr?.symbol || currency} успешно получена!\n` +
                    `💫 На ваш счет зачислено ${credits} кредитов.\n` +
                    `💰 Ваш текущий баланс: ${user_current_credits + credits} кредитов`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💫 Начать обработку', callback_data: 'start_processing' }],
                                [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                            ]
                        }
                    }
                );
            } else if (payment_status === 'failed') {
                await this.bot.telegram.sendMessage(
                    user_id,
                    '❌ Оплата не была завершена. Попробуйте снова или выберите другой способ оплаты.',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💳 Попробовать снова', callback_data: 'buy_credits' }],
                                [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                            ]
                        }
                    }
                );
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Ошибка при обработке webhook:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}

export function setupPaymentCommands(bot: Telegraf, pool: Pool): void {
    bot.action('buy_credits', async (ctx) => {
        try {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '4 генерации (125₽/шт)', callback_data: 'buy_1_RUB' }],
                    [{ text: '8 генераций (87.5₽/шт)', callback_data: 'buy_2_RUB' }],
                    [{ text: '16 генераций (70₽/шт)', callback_data: 'buy_3_RUB' }],
                    [{ text: '50 генераций (50₽/шт)', callback_data: 'buy_4_RUB' }],
                    [{ text: '↩️ Назад', callback_data: 'back_to_menu' }]
                ]
            };

            await ctx.answerCbQuery();
            await ctx.editMessageCaption(
                '💫 Выберите количество генераций:\n\n' +
                'ℹ️ Чем больше пакет, тем выгоднее цена за генерацию!\n\n' +
                '💳 После выбора пакета вы сможете выбрать удобный способ оплаты:\n' +
                '• Банковская карта (RUB)\n' +
                '• Банковская карта (KZT)\n' +
                '• Банковская карта (UZS)\n' +
                '• Криптовалюта',
                { reply_markup: keyboard }
            );
        } catch (error) {
            console.error('Ошибка при выборе способа оплаты:', error);
            await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
        }
    });

    bot.action(/buy_(\d+)_(.+)/, async (ctx) => {
        try {
            const packageId = parseInt(ctx.match[1]);
            const currency = ctx.match[2] as SupportedCurrency;
            const userId = ctx.from?.id;

            if (!userId) {
                await ctx.answerCbQuery('ID пользователя не найден');
                return;
            }

            await ctx.answerCbQuery();

            const rukassaPayment = new RukassaPayment(pool, bot);
            const paymentUrl = await rukassaPayment.createPayment(userId, packageId, currency);

            const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
            const pricePerCredit = package_ ? Math.round(package_.prices.RUB / package_.credits) : 0;

            if (!package_) {
                throw new Error('Некорректные данные пакета');
            }

            const paymentKeyboard = {
                inline_keyboard: [
                    [{ text: '💳 Перейти к оплате', url: paymentUrl }],
                    [{ text: '↩️ Назад к выбору пакета', callback_data: 'buy_credits' }]
                ]
            };

            await ctx.editMessageMedia(
                {
                    type: 'photo',
                    media: { source: './assets/payment_process.jpg' },
                    caption: '🔄 Создан платеж:\n\n' +
                            `📦 Пакет: ${package_.description}\n` +
                            `💰 Стоимость: ${package_.prices.RUB}₽ (${pricePerCredit}₽/шт)\n\n` +
                            '✅ Нажмите кнопку ниже для перехода к оплате.\n' +
                            '⚡️ После оплаты кредиты будут начислены автоматически!\n\n' +
                            '💡 На странице оплаты вы сможете выбрать удобный способ оплаты'
                },
                { reply_markup: paymentKeyboard }
            );
        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            
            let errorMessage = '❌ Произошла ошибка при создании платежа.';
            if (error instanceof Error) {
                if (error.message.includes('У вас уже есть незавершенный платеж')) {
                    errorMessage = '⚠️ У вас уже есть незавершенный платеж.\n' +
                                 'Пожалуйста, завершите его или дождитесь отмены.';
                } else if (error.message.includes('Минимальная сумма')) {
                    errorMessage = error.message;
                }
            }

            await ctx.reply(
                errorMessage,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '↩️ Вернуться к выбору', callback_data: 'buy_credits' }],
                            [{ text: '🏠 В главное меню', callback_data: 'back_to_menu' }]
                        ]
                    }
                }
            );
        }
    });
}

export function setupRukassaWebhook(app: express.Express, rukassaPayment: RukassaPayment): void {
    app.post('/rukassa/webhook', express.json(), async (req, res) => {
        try {
            console.log('Получен webhook от Rukassa:', {
                path: req.path,
                timestamp: new Date().toISOString()
            });
            console.log('Headers:', req.headers);
            console.log('Body:', JSON.stringify(req.body, null, 2));

            await rukassaPayment.handleWebhook(req.body);
            res.json({ status: 'success' });
        } catch (error) {
            console.error('Ошибка обработки webhook от Rukassa:', error);
            res.status(500).json({ 
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    setupPaymentPages(app);
}
function setupPaymentPages(app: express.Express): void {
    app.get('/payment/success', (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Оплата успешна</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        background-color: #f0f2f5;
                    }
                    .container {
                        text-align: center;
                        padding: 2rem;
                        background: white;
                        border-radius: 12px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                        max-width: 90%;
                        width: 400px;
                    }
                    .success-icon {
                        font-size: 64px;
                        margin-bottom: 1rem;
                    }
                    h1 { color: #4CAF50; }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 8px;
                        text-decoration: none;
                        margin-top: 1rem;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success-icon">✅</div>
                    <h1>Оплата успешно завершена!</h1>
                    <p>Кредиты уже начислены на ваш баланс.</p>
                    <p>Вернитесь в Telegram бот для продолжения работы.</p>
                    <a href="tg://resolve?domain=photowombot" class="telegram-button">
                        Открыть бот
                    </a>
                </div>
            </body>
            </html>
        `);
    });

    app.get('/payment/fail', (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Ошибка оплаты</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        background-color: #f0f2f5;
                    }
                    .container {
                        text-align: center;
                        padding: 2rem;
                        background: white;
                        border-radius: 12px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                        max-width: 90%;
                        width: 400px;
                    }
                    .error-icon {
                        font-size: 64px;
                        margin-bottom: 1rem;
                    }
                    h1 { color: #f44336; }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 8px;
                        text-decoration: none;
                        margin-top: 1rem;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="error-icon">❌</div>
                    <h1>Ошибка оплаты</h1>
                    <p>К сожалению, произошла ошибка при обработке платежа.</p>
                    <p>Вернитесь в Telegram бот и попробуйте снова.</p>
                    <a href="tg://resolve?domain=photowombot" class="telegram-button">
                        Открыть бот
                    </a>
                </div>
            </body>
            </html>
        `);
    });

    app.get('/payment/back', (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html lang="ru">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Отмена оплаты</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        background-color: #f0f2f5;
                    }
                    .container {
                        text-align: center;
                        padding: 2rem;
                        background: white;
                        border-radius: 12px;
                        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                        max-width: 90%;
                        width: 400px;
                    }
                    .back-icon {
                        font-size: 64px;
                        margin-bottom: 1rem;
                    }
                    h1 { color: #2196F3; }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 8px;
                        text-decoration: none;
                        margin-top: 1rem;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="back-icon">↩️</div>
                    <h1>Платеж отменен</h1>
                    <p>Вернитесь в Telegram бот чтобы создать новый платеж.</p>
                    <a href="tg://resolve?domain=photowombot" class="telegram-button">
                        Открыть бот
                    </a>
                </div>
            </body>
            </html>
        `);
    });

    // Добавляем эндпоинт для проверки здоровья сервиса
    app.get('/payment/health', (req, res) => {
        res.status(200).json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            webhook_url: `${WEBHOOK_URL}/rukassa/webhook`
        });
    });

    // Добавляем тестовый эндпоинт для проверки статуса платежа
    app.get('/payment/status/:orderId', async (req, res) => {
        try {
            const rukassaPayment = new RukassaPayment(pool, bot);
            const status = await rukassaPayment.checkPaymentStatus(req.params.orderId);
            res.json({ 
                order_id: req.params.orderId,
                status,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({ 
                error: 'Failed to check payment status',
                details: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });
}

// Функция для периодической проверки зависших платежей
export async function cleanupStaleTasks(pool: Pool, bot: Telegraf): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const stalePayments = await client.query(`
            SELECT user_id, merchant_order_id 
            FROM payments 
            WHERE status = 'pending' 
            AND created_at < NOW() - INTERVAL '30 minutes'
        `);

        const rukassaPayment = new RukassaPayment(pool, bot);

        for (const payment of stalePayments.rows) {
            console.log(`Проверка зависшего платежа: ${payment.merchant_order_id}`);
            
            const status = await rukassaPayment.checkPaymentStatus(payment.merchant_order_id);
            
            if (status === 'PAID' || status === 'paid') {
                console.log(`Обнаружен оплаченный платеж: ${payment.merchant_order_id}`);
                await rukassaPayment.handleWebhook({
                    shop_id: SHOP_ID,
                    amount: '0',
                    order_id: payment.merchant_order_id,
                    payment_status: 'paid',
                    payment_method: 'card',
                    custom_fields: '{}',
                    merchant_order_id: payment.merchant_order_id,
                    sign: ''
                });
            } else if (status === 'failed' || status === 'expired' || status === 'error') {
                console.log(`Отмена зависшего платежа: ${payment.merchant_order_id}`);
                await client.query(
                    'UPDATE payments SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE merchant_order_id = $2',
                    [status, payment.merchant_order_id]
                );

                await bot.telegram.sendMessage(
                    payment.user_id,
                    '⚠️ Время ожидания оплаты истекло. Пожалуйста, создайте новый платеж.',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💳 Создать новый платеж', callback_data: 'buy_credits' }],
                                [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                            ]
                        }
                    }
                ).catch(console.error);
            }
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Ошибка при очистке старых платежей:', error);
    } finally {
        client.release();
    }
}

// Экспортируем функцию очистки для использования в основном файле
export function startCleanupTask(pool: Pool, bot: Telegraf): void {
    // Запускаем очистку каждые 5 минут
    setInterval(() => cleanupStaleTasks(pool, bot), 5 * 60 * 1000);
}