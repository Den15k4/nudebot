import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';

// Environment configuration
const SHOP_ID = process.env.SHOP_ID || '2660';
const RUKASSA_TOKEN = process.env.RUKASSA_TOKEN || '9876a82910927a2c9a43f34cb5ad2de7';
const RUKASSA_API_URL = 'https://lk.rukassa.pro/api/v1';

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

interface RukassaResponse {
    status: string;
    error?: string;
    link?: string;
    order_id?: string;
    message?: string;
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
                    payment_method TEXT,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log('Payments table initialized');
        } catch (error) {
            console.error('Error initializing payments table:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    private async createPaymentRecord(
        userId: number,
        merchantOrderId: string,
        amount: number,
        credits: number,
        currency: string,
        method: string
    ): Promise<void> {
        await this.pool.query(
            `INSERT INTO payments 
             (user_id, merchant_order_id, amount, credits, status, currency, payment_method) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, merchantOrderId, amount, credits, 'pending', currency, method]
        );
    }

    async createPayment(userId: number, packageId: number, currency: SupportedCurrency): Promise<string> {
        const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
        if (!package_) {
            throw new Error('Invalid package ID');
        }

        const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
        if (!curr) {
            throw new Error('Unsupported currency');
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        const amount = package_.prices[currency];

        try {
            // Create payment record in database
            await this.createPaymentRecord(
                userId,
                merchantOrderId,
                amount,
                package_.credits,
                currency,
                curr.method
            );

            // Prepare request to Rukassa
            const requestData = {
                shop_id: SHOP_ID,
                token: RUKASSA_TOKEN,
                order_id: merchantOrderId,
                amount: amount.toString(),
                method: curr.method,
                currency: currency,
                test: process.env.NODE_ENV !== 'production' ? 1 : 0
            };

            console.log('Sending request to Rukassa:', {
                ...requestData,
                token: '***hidden***'
            });

            const response = await axios.post<RukassaResponse>(
                `${RUKASSA_API_URL}/create`,
                requestData,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                }
            );

            console.log('Rukassa response:', response.data);

            if (!response.data.link) {
                throw new Error(response.data.message || 'Failed to create payment');
            }

            return response.data.link;

        } catch (error) {
            console.error('Payment creation error:', error);
            
            // Cleanup failed payment record
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            ).catch(err => console.error('Error deleting failed payment:', err));
            
            if (axios.isAxiosError(error)) {
                throw new Error(error.response?.data?.message || 'Payment creation failed');
            }
            throw error;
        }
    }

    async handleWebhook(data: any): Promise<void> {
        console.log('Received webhook data:', data);

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Verify webhook signature if required

            // Update payment status
            const result = await client.query(
                `UPDATE payments 
                 SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP 
                 WHERE merchant_order_id = $3 
                 RETURNING user_id, credits, currency, amount`,
                [data.status, data.order_id, data.merchant_order_id]
            );

            if (result.rows.length === 0) {
                throw new Error('Payment not found');
            }

            const payment = result.rows[0];

            if (data.status === 'success') {
                // Add credits to user account
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [payment.credits, payment.user_id]
                );

                // Notify user about successful payment
                const curr = SUPPORTED_CURRENCIES.find(c => c.code === payment.currency);
                await this.bot.telegram.sendMessage(
                    payment.user_id,
                    `✅ Оплата ${payment.amount} ${curr?.symbol || payment.currency} успешно получена!\n` +
                    `На ваш счет зачислено ${payment.credits} кредитов.`
                );
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Webhook handling error:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}

export function setupPaymentCommands(bot: Telegraf, pool: Pool): void {
    const rukassaPayment = new RukassaPayment(pool, bot);

    // Command to start payment process
    bot.command('buy', async (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🇷🇺 Рубли', 'currency_RUB')],
            [Markup.button.callback('🇰🇿 Тенге', 'currency_KZT')],
            [Markup.button.callback('🇺🇿 Сум', 'currency_UZS')],
            [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')]
        ]);

        await ctx.reply('💳 Выберите способ оплаты:', keyboard);
    });

    // Currency selection handler
    bot.action(/currency_(.+)/, async (ctx) => {
        try {
            const currency = ctx.match[1] as SupportedCurrency;
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
            
            if (!curr) {
                await ctx.answerCbQuery('Unsupported currency');
                return;
            }

            const keyboard = Markup.inlineKeyboard(
                CREDIT_PACKAGES.map(pkg => [
                    Markup.button.callback(
                        `${pkg.description} - ${pkg.prices[currency]} ${curr.symbol}`,
                        `buy_${pkg.id}_${currency}`
                    )
                ])
            );

            await ctx.editMessageText(
                `💳 Выберите пакет кредитов (цены в ${curr.name}):`,
                keyboard
            );
        } catch (error) {
            console.error('Currency selection error:', error);
            await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
        }
    });

    // Package selection and payment creation handler
    bot.action(/buy_(\d+)_(.+)/, async (ctx) => {
        try {
            const packageId = parseInt(ctx.match[1]);
            const currency = ctx.match[2] as SupportedCurrency;
            const userId = ctx.from?.id;

            if (!userId) {
                await ctx.answerCbQuery('User ID not found');
                return;
            }

            const paymentUrl = await rukassaPayment.createPayment(userId, packageId, currency);
            const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);

            await ctx.reply(
                `🔄 Для оплаты ${package_?.credits} кредитов (${package_?.prices[currency]} ${curr?.symbol})\n` +
                `перейдите по ссылке: ${paymentUrl}\n\n` +
                'После оплаты кредиты будут автоматически зачислены на ваш счет.'
            );
        } catch (error) {
            console.error('Payment creation error:', error);
            await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
        }
    });
}

export function setupRukassaWebhook(app: express.Express, rukassaPayment: RukassaPayment): void {
    app.post('/rukassa/webhook', express.json(), async (req, res) => {
        try {
            console.log('Received Rukassa webhook:', req.body);
            await rukassaPayment.handleWebhook(req.body);
            res.json({ status: 'success' });
        } catch (error) {
            console.error('Rukassa webhook error:', error);
            res.status(500).json({ 
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });
}