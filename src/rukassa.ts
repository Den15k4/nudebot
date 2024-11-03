import { Telegraf } from 'telegraf';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';
import crypto from 'crypto';

// Интерфейс для обработчика реферальных платежей
interface ReferralPaymentHandler {
    processReferralPayment: (userId: number, amount: number) => Promise<void>;
}

// Основные конфигурационные параметры
const SHOP_ID = process.env.SHOP_ID || '2660';
const TOKEN = process.env.TOKEN || '9876a82910927a2c9a43f34cb5ad2de7';
const RUKASSA_API_URL = 'https://lk.rukassa.pro/api/v1/create';
const BASE_WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app';

// Курсы валют к рублю
const CURRENCY_RATES = {
    RUB: 1,
    KZT: 0.21,
    UZS: 0.0075,
    CRYPTO: 95
};

// Интерфейсы
interface RukassaCreatePaymentResponse {
    status: boolean;
    error?: string;
    message?: string;
    url?: string;
    link?: string;
    id?: number;
    hash?: string;
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

interface Price {
    [key: string]: number;
    RUB: number;
    KZT: number;
    UZS: number;
    CRYPTO: number;
}

type SupportedCurrency = 'RUB' | 'KZT' | 'UZS' | 'CRYPTO';

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
        minAmount: 300
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Visa/MC (KZT)', 
        method: 'card_kzt',
        minAmount: 32500
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Visa/MC (UZS)', 
        method: 'card_uzs',
        minAmount: 86000
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Криптовалюта', 
        method: 'crypto',
        minAmount: 3
    }
];

// Пакеты с ценами
const CREDIT_PACKAGES: PaymentPackage[] = [
    {
        id: 1,
        credits: 3,
        prices: {
            RUB: 300,
            KZT: 32500,
            UZS: 86000,
            CRYPTO: 3.00
        },
        description: '3 генерации'
    },
    {
        id: 2,
        credits: 7,
        prices: {
            RUB: 600,
            KZT: 58500,
            UZS: 154800,
            CRYPTO: 6.00
        },
        description: '7 генераций'
    },
    {
        id: 3,
        credits: 15,
        prices: {
            RUB: 1200,
            KZT: 108000,
            UZS: 286000,
            CRYPTO: 12.00
        },
        description: '15 генераций'
    },
    {
        id: 4,
        credits: 30,
        prices: {
            RUB: 2000,
            KZT: 195000,
            UZS: 516000,
            CRYPTO: 20.00
        },
        description: '30 генераций'
    }
];

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
            
            // Проверяем существование таблицы
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

    private validateSignature(data: RukassaWebhookBody): boolean {
        const signString = `${data.shop_id}:${data.amount}:${data.order_id}:${TOKEN}`;
        const calculatedSign = crypto.createHash('md5').update(signString).digest('hex');
        return calculatedSign === data.sign;
    }

    private convertToRubles(amount: number, currency: SupportedCurrency): string {
        const rubles = Math.round(amount * CURRENCY_RATES[currency]);
        return rubles.toString();
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

        if (package_.prices[currency] < curr.minAmount) {
            throw new Error(`Минимальная сумма для ${currency}: ${curr.minAmount} ${curr.symbol}`);
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        const amountInRubles = this.convertToRubles(package_.prices[currency], currency);
        
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Проверяем наличие незавершенных платежей
            const pendingPayments = await client.query(
                'SELECT COUNT(*) FROM payments WHERE user_id = $1 AND status = $2',
                [userId, 'pending']
            );

            if (pendingPayments.rows[0].count > 0) {
                throw new Error('У вас уже есть незавершенный платеж');
            }

            await client.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, merchantOrderId, package_.prices[currency], package_.credits, 'pending', currency]
            );

            const formData = new URLSearchParams();
            formData.append('shop_id', SHOP_ID);
            formData.append('token', TOKEN);
            formData.append('order_id', merchantOrderId);
            formData.append('amount', amountInRubles);
            formData.append('method', curr.method);
            formData.append('user_code', userId.toString());
            formData.append('currency_in', currency);
            formData.append('webhook_url', `${BASE_WEBHOOK_URL}/rukassa/webhook`);
            formData.append('success_url', `${BASE_WEBHOOK_URL}/payment/success`);
            formData.append('fail_url', `${BASE_WEBHOOK_URL}/payment/fail`);
            formData.append('back_url', `${BASE_WEBHOOK_URL}/payment/back`);

            formData.append('custom_fields', JSON.stringify({
                user_id: userId,
                package_id: packageId,
                credits: package_.credits,
                original_amount: package_.prices[currency],
                original_currency: currency,
                description: `${package_.description} для пользователя ${userId}`
            }));

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
                throw new Error(`Ошибка оплаты: ${error.response?.data?.message || error.response?.data?.error || 'Сервис временно недоступен'}`);
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async handleWebhook(data: RukassaWebhookBody): Promise<void> {
        console.log('Получены данные webhook:', data);

        if (!this.validateSignature(data)) {
            throw new Error('Invalid webhook signature');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const paymentResult = await client.query(
                'UPDATE payments SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE merchant_order_id = $3 RETURNING user_id, credits, currency, amount',
                [data.payment_status, data.order_id, data.merchant_order_id]
            );

            if (paymentResult.rows.length === 0) {
                throw new Error('Платёж не найден');
            }

            const { user_id, credits, currency, amount } = paymentResult.rows[0];

            if (data.payment_status === 'paid') {
                // Проверяем существование пользователя
                const userExists = await client.query(
                    'SELECT 1 FROM users WHERE user_id = $1',
                    [user_id]
                );

                if (!userExists.rows.length) {
                    throw new Error('Пользователь не найден');
                }

                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [credits, user_id]
                );

                const amountInRub = parseFloat(data.amount);
                if (!isNaN(amountInRub) && this.referralHandler) {
                    try {
                        await this.referralHandler.processReferralPayment(user_id, amountInRub);
                    } catch (error) {
                        console.error('Ошибка при обработке реферального платежа:', error);
                    }
                }

                const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата ${amount} ${curr?.symbol || currency} успешно получена!\n` +
                    `💫 На ваш счет зачислено ${credits} кредитов.`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💫 Начать обработку', callback_data: 'start_processing' }],
                                [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                            ]
                        }
                    }
                );
            } else if (data.payment_status === 'failed') {
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
            console.log(`Webhook обработан успешно: статус=${data.payment_status}, пользователь=${user_id}`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Ошибка при обработке webhook:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Метод для очистки старых платежей
    async cleanupStalePayments(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const stalePayments = await client.query(`
                UPDATE payments 
                SET status = 'expired'
                WHERE status = 'pending' 
                AND created_at < NOW() - INTERVAL '1 hour'
                RETURNING user_id
            `);

            for (const row of stalePayments.rows) {
                try {
                    await this.bot.telegram.sendMessage(
                        row.user_id,
                        '⚠️ Время ожидания оплаты истекло. Пожалуйста, создайте новый платеж.',
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '💳 Создать новый платеж', callback_data: 'buy_credits' }],
                                    [{ text: '↩️ В главное меню', callback_data: 'back_to_menu' }]
                                ]
                            }
                        }
                    );
                } catch (error) {
                    console.error('Ошибка при отправке уведомления о просроченном платеже:', error);
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
}

export function setupPaymentCommands(bot: Telegraf, pool: Pool): void {
    bot.action(/currency_(.+)/, async (ctx) => {
        try {
            const currency = ctx.match[1] as string;
            if (!SUPPORTED_CURRENCIES.find(c => c.code === currency)) {
                await ctx.answerCbQuery('Неподдерживаемая валюта');
                return;
            }

            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency)!;
            
            const packagesKeyboard = {
                inline_keyboard: [
                    ...CREDIT_PACKAGES
                        .filter(pkg => pkg.prices[currency] >= curr.minAmount)
                        .map(pkg => [{
                            text: `${pkg.description} - ${pkg.prices[currency]} ${curr.symbol}`,
                            callback_data: `buy_${pkg.id}_${currency}`
                        }]),
                    [{ text: '↩️ Назад к способам оплаты', callback_data: 'buy_credits' }]
                ]
            };

            await ctx.answerCbQuery();
            await ctx.editMessageCaption(
                `💫 Выберите пакет кредитов (${curr.name}):\n\n` +
                `ℹ️ Чем больше пакет, тем выгоднее цена за кредит!`,
                { reply_markup: packagesKeyboard }
            );
        } catch (error) {
            console.error('Ошибка при выборе валюты:', error);
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
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);

            if (!package_ || !curr) {
                throw new Error('Некорректные данные пакета или валюты');
            }

            const paymentKeyboard = {
                inline_keyboard: [
                    [{ text: '💳 Перейти к оплате', url: paymentUrl }],
                    [{ text: '↩️ Назад к выбору пакета', callback_data: `currency_${currency}` }]
                ]
            };

            await ctx.editMessageMedia(
                {
                    type: 'photo',
                    media: { source: './assets/payment_process.jpg' },
                    caption: '🔄 Создан платеж:\n\n' +
                            `📦 Пакет: ${package_.description}\n` +
                            `💰 Сумма: ${package_.prices[currency]} ${curr.symbol}\n\n` +
                            '✅ Нажмите кнопку ниже для перехода к оплате.\n' +
                            '⚡️ После оплаты кредиты будут начислены автоматически!'
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
            
            // Проверка наличия необходимых полей
            const requiredFields = ['shop_id', 'amount', 'order_id', 'payment_status', 'merchant_order_id', 'sign'];
            const missingFields = requiredFields.filter(field => !req.body[field]);
            
            if (missingFields.length > 0) {
                console.error('Missing required fields:', missingFields);
                return res.status(400).json({ 
                    status: 'error',
                    message: `Missing required fields: ${missingFields.join(', ')}`
                });
            }
            
            await rukassaPayment.handleWebhook(req.body);
            console.log('Webhook обработан успешно', {
                timestamp: new Date().toISOString(),
                webhookUrl: `${BASE_WEBHOOK_URL}/rukassa/webhook`
            });
            
            res.json({ status: 'success' });
        } catch (error) {
            console.error('Ошибка обработки webhook от Rukassa:', error);
            
            if (error instanceof Error && error.message === 'Invalid webhook signature') {
                return res.status(403).json({ 
                    status: 'error',
                    message: 'Invalid signature'
                });
            }
            
            res.status(500).json({ 
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    // Страницы успешной оплаты, ошибки и возврата остаются без изменений
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
                        color: #1a1a1a;
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
                        animation: bounce 1s ease infinite;
                    }
                    @keyframes bounce {
                        0%, 100% { transform: translateY(0); }
                        50% { transform: translateY(-10px); }
                    }
                    h1 {
                        color: #4CAF50;
                        margin: 0.5rem 0;
                        font-size: 24px;
                    }
                    p {
                        color: #666;
                        line-height: 1.5;
                        margin: 1rem 0;
                    }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 8px;
                        text-decoration: none;
                        margin-top: 1rem;
                        transition: all 0.3s ease;
                        font-weight: bold;
                    }
                    .telegram-button:hover {
                        background-color: #006699;
                        transform: translateY(-2px);
                        box-shadow: 0 4px 12px rgba(0,136,204,0.3);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success-icon">✅</div>
                    <h1>Оплата успешно завершена!</h1>
                    <p>Кредиты уже начислены на ваш баланс.</p>
                    <p>Вернитесь в Telegram бот для продолжения работы.</p>
                    <a href="tg://resolve?domain=your_bot_username" class="telegram-button">
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
                        color: #1a1a1a;
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
                        animation: shake 0.5s ease-in-out;
                    }
                    @keyframes shake {
                        0%, 100% { transform: translateX(0); }
                        25% { transform: translateX(-10px); }
                        75% { transform: translateX(10px); }
                    }
                    h1 {
                        color: #f44336;
                        margin: 0.5rem 0;
                        font-size: 24px;
                    }
                    p {
                        color: #666;
                        line-height: 1.5;
                        margin: 1rem 0;
                    }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 8px;
                        text-decoration: none;
                        margin-top: 1rem;
                        transition: all 0.3s ease;
                        font-weight: bold;
                    }
                    .telegram-button:hover {
                        background-color: #006699;
                        transform: translateY(-2px);
                        box-shadow: 0 4px 12px rgba(0,136,204,0.3);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="error-icon">❌</div>
                    <h1>Ошибка оплаты</h1>
                    <p>К сожалению, произошла ошибка при обработке платежа.</p>
                    <p>Вернитесь в Telegram бот и попробуйте снова.</p>
                    <a href="tg://resolve?domain=your_bot_username" class="telegram-button">
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
                        color: #1a1a1a;
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
                    h1 {
                        color: #2196F3;
                        margin: 0.5rem 0;
                        font-size: 24px;
                    }
                    p {
                        color: #666;
                        line-height: 1.5;
                        margin: 1rem 0;
                    }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 8px;
                        text-decoration: none;
                        margin-top: 1rem;
                        transition: all 0.3s ease;
                        font-weight: bold;
                    }
                    .telegram-button:hover {
                        background-color: #006699;
                        transform: translateY(-2px);
                        box-shadow: 0 4px 12px rgba(0,136,204,0.3);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="back-icon">↩️</div>
                    <h1>Оплата отменена</h1>
                    <p>Вы можете вернуться в Telegram бот и попробовать снова.</p>
                    <a href="tg://resolve?domain=your_bot_username" class="telegram-button">
                        Открыть бот
                    </a>
                </div>
            </body>
            </html>
        `);
    });

    // Health check для платежной системы
    app.get('/payment/health', (req, res) => {
        res.status(200).json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            webhook_url: `${BASE_WEBHOOK_URL}/rukassa/webhook`
        });
    });
}