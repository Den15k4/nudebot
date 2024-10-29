import { Telegraf } from 'telegraf';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';
import { MultiBotManager } from './multibot';

// Основные конфигурационные параметры
const SHOP_ID = process.env.SHOP_ID || '2660';
const TOKEN = process.env.TOKEN || '9876a82910927a2c9a43f34cb5ad2de7';
const RUKASSA_API_URL = 'https://lk.rukassa.pro/api/v1/create';
const WEBHOOK_URL = process.env.WEBHOOK_URL?.replace('/webhook', '') || 'https://nudebot-production.up.railway.app';

// Курсы валют к рублю
const CURRENCY_RATES: Record<SupportedCurrency, number> = {
    RUB: 1,
    KZT: 0.21,
    UZS: 0.0075,
    CRYPTO: 95
};

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

interface PaymentPackage {
    id: number;
    credits: number;
    prices: Record<SupportedCurrency, number>;
    description: string;
}

interface Currency {
    code: SupportedCurrency;
    symbol: string;
    name: string;
    method: string;
    minAmount: number;
}

type SupportedCurrency = 'RUB' | 'KZT' | 'UZS' | 'CRYPTO';

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

export class RukassaPayment {
    private pool: Pool;
    private bot: Telegraf;
    private botId: string;

    constructor(pool: Pool, bot: Telegraf, botId: string) {
        this.pool = pool;
        this.bot = bot;
        this.botId = botId;
    }

    async initPaymentsTable(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS payments (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT REFERENCES users(user_id),
                    bot_id TEXT NOT NULL,
                    order_id TEXT UNIQUE,
                    merchant_order_id TEXT UNIQUE,
                    amount DECIMAL,
                    credits INTEGER,
                    status TEXT,
                    currency TEXT,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_payments_bot_id ON payments(bot_id);
                CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
                CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
            `);
            console.log('Таблица payments успешно создана или обновлена');
        } catch (error) {
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

        const merchantOrderId = `${this.botId}_${userId}_${Date.now()}`;
        const amountInRubles = this.convertToRubles(package_.prices[currency], currency);
        
        try {
            // Сохраняем платеж в базе
            await this.pool.query(
                'INSERT INTO payments (user_id, bot_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [userId, this.botId, merchantOrderId, package_.prices[currency], package_.credits, 'pending', currency]
            );

            const formData = new URLSearchParams();
            formData.append('shop_id', SHOP_ID);
            formData.append('token', TOKEN);
            formData.append('user_code', userId.toString());
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
                bot_id: this.botId,
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

            return paymentUrl;

        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            ).catch(err => console.error('Ошибка при удалении платежа:', err));
            
            if (axios.isAxiosError(error)) {
                const errorMessage = error.response?.data?.message || 
                                   error.response?.data?.error || 
                                   'Сервис временно недоступен';
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
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const paymentResult = await client.query(
                `UPDATE payments 
                SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE merchant_order_id = $3 
                RETURNING id, user_id, credits, currency, amount, bot_id`,
                [data.payment_status, data.order_id, data.merchant_order_id]
            );

            if (paymentResult.rows.length === 0) {
                throw new Error('Платёж не найден');
            }

            const payment = paymentResult.rows[0];

            if (data.payment_status === 'paid') {
                // Начисляем кредиты пользователю
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [payment.credits, payment.user_id]
                );

                // Проверяем наличие реферала
                const referralQuery = await client.query(
                    'SELECT referral_id FROM users WHERE user_id = $1',
                    [payment.user_id]
                );

                const referrerId = referralQuery.rows[0]?.referral_id;
                if (referrerId) {
                    // Рассчитываем реферальное начисление (50% от суммы)
                    const referralAmount = payment.amount * 0.5;

                    // Создаем запись о начислении
                    await client.query(
                        `INSERT INTO referral_earnings 
                        (referrer_id, referred_id, payment_id, amount) 
                        VALUES ($1, $2, $3, $4)`,
                        [referrerId, payment.user_id, payment.id, referralAmount]
                    );

                    // Обновляем общий баланс реферала
                    await client.query(
                        `UPDATE users 
                        SET total_referral_earnings = total_referral_earnings + $1 
                        WHERE user_id = $2`,
                        [referralAmount, referrerId]
                    );

                    // Отправляем уведомление рефереру
                    await this.bot.telegram.sendMessage(
                        referrerId,
                        `🎉 Вам начислено ${referralAmount}₽ по реферальной программе!\n` +
                        `Спасибо за приглашение новых пользователей!`
                    );
                }

                const curr = SUPPORTED_CURRENCIES.find(c => c.code === payment.currency);
                await this.bot.telegram.sendMessage(
                    payment.user_id,
                    `✅ Оплата ${payment.amount} ${curr?.symbol || payment.currency} успешно получена!\n` +
                    `На ваш счет зачислено ${payment.credits} кредитов.`
                );
            } else if (data.payment_status === 'failed') {
                await this.bot.telegram.sendMessage(
                    payment.user_id,
                    '❌ Оплата не была завершена. Попробуйте снова или выберите другой способ оплаты.'
                );
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

export function setupPaymentCommands(bot: Telegraf, pool: Pool, botId: string): void {
    bot.action(/currency_(.+)/, async (ctx) => {
        try {
            if (!ctx.match) return;
            
            const currency = ctx.match[1] as SupportedCurrency;
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
            
            if (!curr) {
                await ctx.answerCbQuery('Неподдерживаемая валюта');
                return;
            }

            const keyboard = CREDIT_PACKAGES.map(pkg => [{
                text: `${pkg.description} - ${pkg.prices[currency]} ${curr.symbol}`,
                callback_data: `buy_${pkg.id}_${currency}`
            }]);

            await ctx.editMessageText(
                `💳 Выберите пакет кредитов (цены в ${curr.name}):`,
                { reply_markup: { inline_keyboard: keyboard } }
            );
        } catch (error) {
            console.error('Ошибка при выборе валюты:', error);
            await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
        }
    });

    bot.action(/buy_(\d+)_(.+)/, async (ctx) => {
        try {
            if (!ctx.match || !ctx.from?.id) return;

            const [, packageId, currency] = ctx.match;
            const userId = ctx.from.id;

            const rukassaPayment = new RukassaPayment(pool, bot, botId);
            const paymentUrl = await rukassaPayment.createPayment(
                userId,
                parseInt(packageId),
                currency as SupportedCurrency
            );

            const package_ = CREDIT_PACKAGES.find(p => p.id === parseInt(packageId));
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency as SupportedCurrency);

            await ctx.reply(
                `🔄 Для оплаты ${package_?.description} ` +
                `(${package_?.prices[currency as SupportedCurrency]} ${curr?.symbol}) ` +
                `перейдите по ссылке:\n${paymentUrl}\n\n` +
                'После оплаты кредиты будут автоматически зачислены на ваш счет.',
                { disable_web_page_preview: true }
            );
        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
        }
    });
}

export function setupRukassaWebhook(app: express.Express, multiBotManager: MultiBotManager): void {
    app.post('/rukassa/webhook', express.json(), async (req, res) => {
        try {
            console.log('Получен webhook от Rukassa:');
            console.log('Headers:', req.headers);
            console.log('Body:', JSON.stringify(req.body, null, 2));

            const webhookData = req.body as RukassaWebhookBody;
            let customFields;
            
            try {
                customFields = JSON.parse(webhookData.custom_fields || '{}');
            } catch (error) {
                console.error('Ошибка при парсинге custom_fields:', error);
                customFields = {};
            }

            const botId = customFields.bot_id || 'main';
            const payment = multiBotManager.getPayment(botId);

            if (!payment) {
                throw new Error(`Payment handler not found for bot ${botId}`);
            }

            await payment.handleWebhook(webhookData);
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

    function getPaymentPageHtml(title: string, status: 'success' | 'fail' | 'back'): string {
        const colors = {
            success: '#4CAF50',
            fail: '#f44336',
            back: '#2196F3'
        };
        
        const emojis = {
            success: '✅',
            fail: '❌',
            back: '↩️'
        };

        const messages = {
            success: 'Оплата успешно завершена!',
            fail: 'Ошибка оплаты',
            back: 'Оплата отменена'
        };

        const descriptions = {
            success: 'Вернитесь в Telegram бот для проверки баланса.',
            fail: 'Вернитесь в Telegram бот и попробуйте снова.',
            back: 'Вернитесь в Telegram бот для создания нового платежа.'
        };

        return `
            <!DOCTYPE html>
            <html>
                <head>
                    <title>${title}</title>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            background-color: #f5f5f5;
                        }
                        .container {
                            text-align: center;
                            padding: 2rem;
                            background: white;
                            border-radius: 10px;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                            max-width: 90%;
                            width: 400px;
                        }
                        h1 {
                            color: ${colors[status]};
                            margin-bottom: 1rem;
                        }
                        p {
                            color: #666;
                            line-height: 1.5;
                        }
                        .emoji {
                            font-size: 3rem;
                            margin-bottom: 1rem;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="emoji">${emojis[status]}</div>
                        <h1>${messages[status]}</h1>
                        <p>${descriptions[status]}</p>
                    </div>
                </body>
            </html>
        `;
    }

    app.get('/payment/success', (req, res) => {
        res.send(getPaymentPageHtml('Оплата успешна', 'success'));
    });

    app.get('/payment/fail', (req, res) => {
        res.send(getPaymentPageHtml('Ошибка оплаты', 'fail'));
    });

    app.get('/payment/back', (req, res) => {
        res.send(getPaymentPageHtml('Отмена оплаты', 'back'));
    });
}

export type {
    RukassaCreatePaymentResponse,
    RukassaWebhookBody,
    PaymentPackage,
    Currency,
    SupportedCurrency
};