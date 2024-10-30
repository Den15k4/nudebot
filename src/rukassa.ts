import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';

// Основные конфигурационные параметры
const SHOP_ID = process.env.SHOP_ID || '2660';
const TOKEN = process.env.TOKEN || '9876a82910927a2c9a43f34cb5ad2de7';
const RUKASSA_API_URL = 'https://lk.rukassa.pro/api/v1/create';
const WEBHOOK_URL = process.env.WEBHOOK_URL?.replace('/webhook', '') || 'https://nudebot-production.up.railway.app';

// Курсы валют к рублю
const CURRENCY_RATES = {
    RUB: 1,
    KZT: 0.21,      // 1 рубль = ~4.76 тенге
    UZS: 0.0075,    // 1 рубль = ~133 сума
    CRYPTO: 95      // 1 USDT = ~95 рублей
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
        minAmount: 32500  // ~300₽
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Visa/MC (UZS)', 
        method: 'card_uzs',
        minAmount: 86000  // ~650₽
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Криптовалюта', 
        method: 'crypto',
        minAmount: 3      // ~300₽
    }
];

// Пакеты с ценами в местных валютах
const CREDIT_PACKAGES: PaymentPackage[] = [
    {
        id: 1,
        credits: 3,
        prices: {
            RUB: 300,     // 300₽
            KZT: 32500,   // ~300₽
            UZS: 86000,   // ~650₽
            CRYPTO: 3.00  // ~300₽
        },
        description: '3 генерации'
    },
    {
        id: 2,
        credits: 7,
        prices: {
            RUB: 600,      // 600₽
            KZT: 58500,    // ~600₽
            UZS: 154800,   // ~1200₽
            CRYPTO: 6.00   // ~600₽
        },
        description: '7 генераций'
    },
    {
        id: 3,
        credits: 15,
        prices: {
            RUB: 1200,     // 1200₽
            KZT: 108000,   // ~1200₽
            UZS: 286000,   // ~2150₽
            CRYPTO: 12.00  // ~1200₽
        },
        description: '15 генераций'
    },
    {
        id: 4,
        credits: 30,
        prices: {
            RUB: 2000,     // 2000₽
            KZT: 195000,   // ~2000₽
            UZS: 516000,   // ~3900₽
            CRYPTO: 20.00  // ~2000₽
        },
        description: '30 генераций'
    }
];

export class RukassaPayment {
    private pool: Pool;
    private bot: Telegraf;

    constructor(pool: Pool, bot: Telegraf) {
        this.pool = pool;
        this.bot = bot;
    }

    async initPaymentsTable(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`
                CREATE TABLE IF NOT EXISTS payments (
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
            `);
            await client.query('COMMIT');
            console.log('Таблица payments успешно создана');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Ошибка при создании таблицы payments:', error);
            throw error;
        } finally {
            client.release();
        }
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
        
        try {
            await this.pool.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, merchantOrderId, package_.prices[currency], package_.credits, 'pending', currency]
            );

            const formData = new URLSearchParams();
            formData.append('shop_id', SHOP_ID);
            formData.append('token', TOKEN);
            formData.append('order_id', merchantOrderId);
            formData.append('amount', amountInRubles);
            formData.append('method', curr.method);
            formData.append('currency_in', currency);
            formData.append('webhook_url', `${WEBHOOK_URL}/rukassa/webhook`);
            formData.append('success_url', `${WEBHOOK_URL}/payment/success`);
            formData.append('fail_url', `${WEBHOOK_URL}/payment/fail`);
            formData.append('back_url', `${WEBHOOK_URL}/payment/back`);

            formData.append('custom_fields', JSON.stringify({
                user_id: userId,
                package_id: packageId,
                credits: package_.credits,
                original_amount: package_.prices[currency],
                original_currency: currency,
                description: `${package_.description} для пользователя ${userId}`
            }));

            console.log('Параметры запроса:', {
                url: RUKASSA_API_URL,
                data: { 
                    ...Object.fromEntries(formData),
                    token: '***hidden***'
                }
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

            console.log('Ответ Rukassa:', response.data);

            if (response.data.error) {
                throw new Error(response.data.message || response.data.error);
            }

            const paymentUrl = response.data.url || response.data.link;
            if (!paymentUrl) {
                throw new Error('Не удалось получить ссылку на оплату');
            }

            return paymentUrl;

        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            ).catch(err => console.error('Ошибка при удалении платежа:', err));
            
            if (axios.isAxiosError(error)) {
                throw new Error(`Ошибка оплаты: ${error.response?.data?.message || error.response?.data?.error || 'Сервис временно недоступен'}`);
            }
            
            throw error;
        }
    }

    async handleWebhook(data: RukassaWebhookBody): Promise<void> {
        console.log('Получены данные webhook:', data);

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
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [credits, user_id]
                );

                const amountInRub = parseFloat(data.amount);
                if (!isNaN(amountInRub)) {
                    try {
                        // Импортируем функцию обработки реферальных платежей
                        const referralHandler = await import('./index');
                        await referralHandler.processReferralPayment(user_id, amountInRub);
                    } catch (error) {
                        console.error('Ошибка при обработке реферального платежа:', error);
                    }
                }

                const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата ${amount} ${curr?.symbol || currency} успешно получена!\n` +
                    `💫 На ваш счет зачислено ${credits} кредитов.`
                );
            } else if (data.payment_status === 'failed') {
                await this.bot.telegram.sendMessage(
                    user_id,
                    '❌ Оплата не была завершена. Попробуйте снова или выберите другой способ оплаты.'
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
}

export function setupPaymentCommands(bot: Telegraf, pool: Pool): void {
    // Обработчик команды покупки кредитов
    bot.hears('💳 Купить кредиты', async (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 Visa/MC (RUB)', 'currency_RUB')],
            [Markup.button.callback('💳 Visa/MC (KZT)', 'currency_KZT')],
            [Markup.button.callback('💳 Visa/MC (UZS)', 'currency_UZS')],
            [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')]
        ]);

        await ctx.replyWithPhoto(
            { source: './assets/payment.jpg' },
            {
                caption: '💳 Выберите способ оплаты:',
                reply_markup: keyboard
            }
        );
    });

    bot.action(/currency_(.+)/, async (ctx) => {
        try {
            const currency = ctx.match[1] as SupportedCurrency;
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
            
            if (!curr) {
                await ctx.answerCbQuery('Неподдерживаемая валюта');
                return;
            }

            const keyboard = Markup.inlineKeyboard([
                ...CREDIT_PACKAGES.map(pkg => [
                    Markup.button.callback(
                        `${pkg.description} - ${pkg.prices[currency]} ${curr.symbol}`,
                        `buy_${pkg.id}_${currency}`
                    )
                ]),
                [Markup.button.callback('↩️ Назад к способам оплаты', 'show_payment_methods')]
            ]);

            await ctx.answerCbQuery();
            await ctx.editMessageCaption(
                `💫 Выберите пакет кредитов (${curr.name}):\n\n` +
                `ℹ️ Чем больше пакет, тем выгоднее цена за кредит!`,
                { reply_markup: keyboard }
            );
        } catch (error) {
            console.error('Ошибка при выборе валюты:', error);
            await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
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

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('💳 Перейти к оплате', paymentUrl)],
                [Markup.button.callback('↩️ Назад к выбору пакета', `currency_${currency}`)]
            ]);

            await ctx.editMessageMedia(
                {
                    type: 'photo',
                    media: { source: './assets/payment_process.jpg' },
                    caption: '🔄 Создан платеж:\n\n' +
                            `📦 Пакет: ${package_?.description}\n` +
                            `💰 Сумма: ${package_?.prices[currency]} ${curr?.symbol}\n\n` +
                            '✅ Нажмите кнопку ниже для перехода к оплате.\n' +
                            '⚡️ После оплаты кредиты будут начислены автоматически!'
                },
                { reply_markup: keyboard }
            );
        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            await ctx.reply(
                '❌ Произошла ошибка при создании платежа.\n' +
                'Пожалуйста, попробуйте позже или выберите другой способ оплаты.'
            );
        }
    });

    // Обработчик кнопки "Назад к способам оплаты"
    bot.action('show_payment_methods', async (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 Visa/MC (RUB)', 'currency_RUB')],
            [Markup.button.callback('💳 Visa/MC (KZT)', 'currency_KZT')],
            [Markup.button.callback('💳 Visa/MC (UZS)', 'currency_UZS')],
            [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')]
        ]);

        try {
            await ctx.editMessageMedia(
                {
                    type: 'photo',
                    media: { source: './assets/payment.jpg' },
                    caption: '💳 Выберите способ оплаты:'
                },
                { reply_markup: keyboard }
            );
        } catch (error) {
            console.error('Ошибка при возврате к способам оплаты:', error);
            await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
        }
    });
}

export function setupRukassaWebhook(app: express.Express, rukassaPayment: RukassaPayment): void {
    app.post('/rukassa/webhook', express.json(), async (req, res) => {
        try {
            console.log('Получен webhook от Rukassa:');
            console.log('Headers:', req.headers);
            console.log('Body:', JSON.stringify(req.body, null, 2));
            
            await rukassaPayment.handleWebhook(req.body);
            console.log('Webhook обработан успешно');
            
            res.json({ status: 'success' });
        } catch (error) {
            console.error('Ошибка обработки webhook от Rukassa:', error);
            res.status(500).json({ 
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

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
                        color: #4CAF50;
                        font-size: 48px;
                        margin-bottom: 1rem;
                    }
                    h1 { color: #4CAF50; margin: 0.5rem 0; }
                    p { color: #666; line-height: 1.5; }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 10px 20px;
                        border-radius: 5px;
                        text-decoration: none;
                        margin-top: 1rem;
                        transition: background-color 0.3s;
                    }
                    .telegram-button:hover {
                        background-color: #006699;
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
                        color: #f44336;
                        font-size: 48px;
                        margin-bottom: 1rem;
                    }
                    h1 { color: #f44336; margin: 0.5rem 0; }
                    p { color: #666; line-height: 1.5; }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 10px 20px;
                        border-radius: 5px;
                        text-decoration: none;
                        margin-top: 1rem;
                        transition: background-color 0.3s;
                    }
                    .telegram-button:hover {
                        background-color: #006699;
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
                        color: #2196F3;
                        font-size: 48px;
                        margin-bottom: 1rem;
                    }
                    h1 { color: #2196F3; margin: 0.5rem 0; }
                    p { color: #666; line-height: 1.5; }
                    .telegram-button {
                        display: inline-block;
                        background-color: #0088cc;
                        color: white;
                        padding: 10px 20px;
                        border-radius: 5px;
                        text-decoration: none;
                        margin-top: 1rem;
                        transition: background-color 0.3s;
                    }
                    .telegram-button:hover {
                        background-color: #006699;
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

    // Эндпоинт для проверки здоровья системы
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            webhook_url: `${WEBHOOK_URL}/rukassa/webhook`
        });
    });
}