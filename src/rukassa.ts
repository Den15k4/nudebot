import { Telegraf, Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';
import { MultiBotManager } from './multibot';

// Используем тот же интерфейс контекста
interface BotContext extends Context {
    message: Update.Message;
}

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
    private bot: Telegraf<BotContext>;
    private botId: string;

    constructor(pool: Pool, bot: Telegraf<BotContext>, botId: string) {
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
                    partner_id TEXT,
                    commission_amount DECIMAL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_payments_bot_id ON payments(bot_id);
                CREATE INDEX IF NOT EXISTS idx_payments_partner_id ON payments(partner_id);
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
            // Получаем информацию о партнере для этого бота
            const partnerResult = await this.pool.query(
                'SELECT partner_id FROM bots WHERE bot_id = $1',
                [this.botId]
            );
            const partnerId = partnerResult.rows[0]?.partner_id;

            // Сохраняем платеж в базе
            await this.pool.query(
                `INSERT INTO payments 
                (user_id, bot_id, merchant_order_id, amount, credits, status, currency, partner_id) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [userId, this.botId, merchantOrderId, package_.prices[currency], 
                 package_.credits, 'pending', currency, partnerId]
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
                partner_id: partnerId,
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

            console.log(`Создан платеж для пользователя ${userId}, заказ ${merchantOrderId}`);
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
        console.log('Получены данные webhook:', data);

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Обновляем статус платежа
            const paymentResult = await client.query(
                `UPDATE payments 
                SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE merchant_order_id = $3 
                RETURNING id, user_id, credits, currency, amount, bot_id, partner_id`,
                [data.payment_status, data.order_id, data.merchant_order_id]
            );

            if (paymentResult.rows.length === 0) {
                throw new Error('Платёж не найден');
            }

            const payment = paymentResult.rows[0];

            if (data.payment_status === 'paid') {
                // Начисляем кредиты пользователю
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2 AND bot_id = $3',
                    [payment.credits, payment.user_id, payment.bot_id]
                );

                // Обрабатываем комиссию партнера, если есть
                if (payment.partner_id) {
                    const partnerResult = await client.query(
                        'SELECT commission_rate FROM partners WHERE partner_id = $1',
                        [payment.partner_id]
                    );
                    
                    if (partnerResult.rows.length > 0) {
                        const commissionRate = partnerResult.rows[0].commission_rate;
                        const commissionAmount = payment.amount * commissionRate;

                        // Обновляем баланс партнера
                        await client.query(
                            'UPDATE partners SET balance = balance + $1 WHERE partner_id = $2',
                            [commissionAmount, payment.partner_id]
                        );

                        // Сохраняем транзакцию партнера
                        await client.query(
                            `INSERT INTO partner_transactions 
                            (partner_id, payment_id, bot_id, amount, commission_amount, status) 
                            VALUES ($1, $2, $3, $4, $5, $6)`,
                            [payment.partner_id, payment.id, payment.bot_id, 
                             payment.amount, commissionAmount, 'completed']
                        );

                        // Обновляем сумму комиссии в платеже
                        await client.query(
                            'UPDATE payments SET commission_amount = $1 WHERE id = $2',
                            [commissionAmount, payment.id]
                        );
                    }
                }

                // Отправляем уведомление пользователю
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
            console.log(`Webhook обработан успешно: статус=${data.payment_status}, пользователь=${payment.user_id}`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Ошибка при обработке webhook:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}

// Настройка команд оплаты
export function setupPaymentCommands(bot: Telegraf<BotContext>, pool: Pool, botId: string): void {
    bot.command('buy', async (ctx: BotContext) => {
        try {
            await ctx.reply('💳 Выберите способ оплаты:', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Visa/MC (RUB)', callback_data: `currency_${botId}_RUB` }],
                        [{ text: '💳 Visa/MC (KZT)', callback_data: `currency_${botId}_KZT` }],
                        [{ text: '💳 Visa/MC (UZS)', callback_data: `currency_${botId}_UZS` }],
                        [{ text: '💎 Криптовалюта', callback_data: `currency_${botId}_CRYPTO` }]
                    ]
                }
            });
        } catch (error) {
            console.error('Ошибка при отображении меню оплаты:', error);
            await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
        }
    });

    // Обработчик выбора валюты
    bot.action(/currency_(.+)_(.+)/, async (ctx: BotContext) => {
        try {
            const [, botIdFromAction, currency] = ctx.match;
            
            // Проверяем, совпадает ли botId из action с текущим ботом
            if (botIdFromAction !== botId) {
                await ctx.answerCbQuery('Недействительная кнопка');
                return;
            }

            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency as SupportedCurrency);
            
            if (!curr) {
                await ctx.answerCbQuery('Неподдерживаемая валюта');
                return;
            }

            // Создаем клавиатуру с пакетами
            const keyboard = CREDIT_PACKAGES.map(pkg => [{
                text: `${pkg.description} - ${pkg.prices[currency as SupportedCurrency]} ${curr.symbol}`,
                callback_data: `buy_${botId}_${pkg.id}_${currency}`
            }]);

            await ctx.answerCbQuery();
            await ctx.editMessageText(
                `💳 Выберите пакет кредитов (цены в ${curr.name}):`,
                {
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                }
            );
        } catch (error) {
            console.error('Ошибка при выборе валюты:', error);
            await ctx.answerCbQuery('Произошла ошибка. Попробуйте позже.');
        }
    });

    // Обработчик выбора пакета
    bot.action(/buy_(.+)_(\d+)_(.+)/, async (ctx: BotContext) => {
        try {
            const [, botIdFromAction, packageId, currency] = ctx.match;
            
            if (botIdFromAction !== botId) {
                await ctx.answerCbQuery('Недействительная кнопка');
                return;
            }

            const userId = ctx.from?.id;
            if (!userId) {
                await ctx.answerCbQuery('ID пользователя не найден');
                return;
            }

            await ctx.answerCbQuery();

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

// Настройка webhook для Rukassa
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

    // Страницы результатов оплаты
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

// Экспорт типов
export type {
    RukassaCreatePaymentResponse,
    RukassaWebhookBody,
    PaymentPackage,
    Currency,
    SupportedCurrency
};