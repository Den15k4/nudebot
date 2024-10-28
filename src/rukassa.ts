import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';

// Environment configuration
const SHOP_ID = process.env.SHOP_ID || '2660';
const TOKEN = process.env.TOKEN || '9876a82910927a2c9a43f34cb5ad2de7';
const RUKASSA_API_URL = 'https://lk.rukassa.pro/api/v1/create';
const WEBHOOK_URL = process.env.WEBHOOK_URL?.replace('/webhook', '') || 'https://nudebot-production.up.railway.app';

// Interfaces
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

interface RukassaCreatePaymentResponse {
    status: boolean;
    error?: string;
    url?: string;
    link?: string;
    order_id?: string;
    message?: string;
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
}

// Supported payment methods and currencies
const SUPPORTED_CURRENCIES: Currency[] = [
    { 
        code: 'RUB', 
        symbol: '₽', 
        name: 'Рубли', 
        method: 'card',
        minAmount: 300
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Тенге', 
        method: 'card_kzt',
        minAmount: 550
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Сум', 
        method: 'card_uzs',
        minAmount: 6350
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Криптовалюта', 
        method: 'crypto',
        minAmount: 1.00
    }
];

const CREDIT_PACKAGES: PaymentPackage[] = [
    {
        id: 1,
        credits: 1,
        prices: {
            RUB: 300,
            KZT: 550,
            UZS: 6350,
            CRYPTO: 1.00
        },
        description: '1 генерация'
    },
    {
        id: 2,
        credits: 3,
        prices: {
            RUB: 600,
            KZT: 1100,
            UZS: 12700,
            CRYPTO: 2.00
        },
        description: '3 генерации'
    },
    {
        id: 3,
        credits: 10,
        prices: {
            RUB: 1500,
            KZT: 2750,
            UZS: 31750,
            CRYPTO: 5.00
        },
        description: '10 генераций'
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
            await client.query('DROP TABLE IF EXISTS payments CASCADE;');
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

    async createPayment(userId: number, packageId: number, currency: SupportedCurrency = 'RUB'): Promise<string> {
        const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
        if (!package_) {
            throw new Error('Неверный ID пакета');
        }

        const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
        if (!curr) {
            throw new Error('Неподдерживаемая валюта');
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        const amount = package_.prices[currency].toString();
        
        try {
            await this.pool.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, merchantOrderId, parseFloat(amount), package_.credits, 'pending', currency]
            );

            const formData = new URLSearchParams();
            formData.append('shop_id', SHOP_ID);
            formData.append('token', TOKEN);
            formData.append('user_code', userId.toString());
            formData.append('order_id', merchantOrderId);
            formData.append('amount', amount);
            formData.append('method', curr.method);
            formData.append('currency_in', currency);
            formData.append('webhook_url', `${WEBHOOK_URL}/rukassa/webhook`);
            formData.append('success_url', `${WEBHOOK_URL}/payment/success`);
            formData.append('fail_url', `${WEBHOOK_URL}/payment/fail`);
            formData.append('back_url', `${WEBHOOK_URL}/payment/back`);
            formData.append('test', '1');
            
            formData.append('custom_fields', JSON.stringify({
                user_id: userId,
                package_id: packageId,
                credits: package_.credits,
                test_payment: true,
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

            if (!response.data.url && !response.data.link) {
                throw new Error('Не удалось получить ссылку на оплату');
            }

            console.log(`Создан тестовый платеж для пользователя ${userId}, заказ ${merchantOrderId}`);
            return response.data.url || response.data.link || '';

        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            ).catch(err => console.error('Ошибка при удалении платежа:', err));
            
            if (axios.isAxiosError(error)) {
                const errorMessage = error.response?.data?.message || error.response?.data?.error || 'Сервис временно недоступен';
                console.error('Детали ошибки API:', {
                    status: error.response?.status,
                    data: error.response?.data
                });
                throw new Error(`Ошибка оплаты: ${errorMessage}`);
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

                const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата ${amount} ${curr?.symbol || currency} успешно получена!\n` +
                    `На ваш счет зачислено ${credits} кредитов.\n\n` +
                    (data.custom_fields?.includes('test_payment') ? '🔧 Тестовый платеж' : '')
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
    bot.command('buy', async (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🇷🇺 Рубли (карта)', 'currency_RUB')],
            [Markup.button.callback('🇰🇿 Тенге (карта)', 'currency_KZT')],
            [Markup.button.callback('🇺🇿 Сум (карта)', 'currency_UZS')],
            [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')]
        ]);

        await ctx.reply(
            '💳 Выберите способ оплаты:',
            keyboard
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

            const keyboard = {
                inline_keyboard: CREDIT_PACKAGES.map(pkg => [
                    Markup.button.callback(
                        `${pkg.description} - ${pkg.prices[currency]} ${curr.symbol}`,
                        `buy_${pkg.id}_${currency}`
                    )
                ])
            };

            await ctx.answerCbQuery();
            await ctx.editMessageText(
                `💳 Выберите пакет кредитов (цены в ${curr.name}):`,
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

            await ctx.reply(
                `🔄 Для оплаты ${package_?.description} (${package_?.prices[currency]} ${curr?.symbol}) перейдите по ссылке:\n` +
                `${paymentUrl}\n\n` +
                '🔧 Тестовый режим активен\n' +
                'Тестовая карта: 4111 1111 1111 1111\n' +
                'Срок действия: 12/25\n' +
                'CVV: 123\n\n' +
                'После оплаты кредиты будут автоматически зачислены на ваш счет.',
                { disable_web_page_preview: true }
            );
        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
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
            // Обработка редиректов после оплаты
app.get('/payment/success', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Оплата успешна</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial, sans-serif;">
                <div style="text-align: center; padding: 20px;">
                    <h1 style="color: #4CAF50;">✅ Оплата успешно завершена!</h1>
                    <p>Вернитесь в Telegram бот для проверки баланса.</p>
                </div>
            </body>
        </html>
    `);
});

app.get('/payment/fail', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Ошибка оплаты</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial, sans-serif;">
                <div style="text-align: center; padding: 20px;">
                    <h1 style="color: #f44336;">❌ Ошибка оплаты</h1>
                    <p>Вернитесь в Telegram бот и попробуйте снова.</p>
                </div>
            </body>
        </html>
    `);
});

app.get('/payment/back', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Отмена оплаты</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial, sans-serif;">
                <div style="text-align: center; padding: 20px;">
                    <h1 style="color: #2196F3;">↩️ Оплата отменена</h1>
                    <p>Вернитесь в Telegram бот для создания нового платежа.</p>
                </div>
            </body>
        </html>
    `);
});