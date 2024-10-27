import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import { Pool } from 'pg';
import express from 'express';

// Конфигурация Rukassa
const SHOP_ID = process.env.SHOP_ID || '';
const TOKEN = process.env.TOKEN || '';
const RUKASSA_API_URL = 'https://lk.rukassa.is/api/v1/create';

// Выводим параметры для проверки
console.log('Initialization params:', {
    SHOP_ID,
    TOKEN: TOKEN.substring(0, 5) + '...',
    API_URL: RUKASSA_API_URL
});

// Интерфейсы
interface Price {
    [key: string]: number;
    RUB: number;
    USD: number;
    UZS: number;
    KZT: number;
}

type SupportedCurrency = 'RUB' | 'USD' | 'UZS' | 'KZT';

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

interface Currency {
    code: SupportedCurrency;
    symbol: string;
    name: string;
}

// Поддерживаемые валюты
const SUPPORTED_CURRENCIES: Currency[] = [
    { code: 'RUB', symbol: '₽', name: 'Рубли' },
    { code: 'USD', symbol: '$', name: 'Доллары' },
    { code: 'UZS', symbol: 'сум', name: 'Сум' },
    { code: 'KZT', symbol: '₸', name: 'Тенге' }
];

// Пакеты кредитов
const CREDIT_PACKAGES: PaymentPackage[] = [
    {
        id: 1,
        credits: 1,
        prices: {
            RUB: 100,
            USD: 1.1,
            UZS: 13000,
            KZT: 450
        },
        description: '1 генерация'
    },
    {
        id: 2,
        credits: 3,
        prices: {
            RUB: 200,
            USD: 2.2,
            UZS: 26000,
            KZT: 900
        },
        description: '3 генерации'
    },
    {
        id: 3,
        credits: 10,
        prices: {
            RUB: 500,
            USD: 5.5,
            UZS: 65000,
            KZT: 2250
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

            // Проверяем существование таблицы
            const tableExists = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'payments'
                );
            `);

            if (tableExists.rows[0].exists) {
                // Если таблица существует, удаляем ее
                await client.query('DROP TABLE IF EXISTS payments CASCADE;');
            }

            // Создаем таблицу с новой структурой
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
            console.log('Таблица payments успешно создана/обновлена');
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

        const merchantOrderId = `${userId}_${Date.now()}`;
        const amount = package_.prices[currency].toString();
        
        try {
            await this.pool.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, merchantOrderId, parseFloat(amount), package_.credits, 'pending', currency]
            );

            // Минимальный набор параметров как в PHP примере
            const paymentData = new URLSearchParams({
                shop_id: SHOP_ID,
                token: TOKEN,
                order_id: merchantOrderId,
                amount: amount
            });

            console.log('Request details:', {
                url: RUKASSA_API_URL,
                data: Object.fromEntries(paymentData),
                shop_id: SHOP_ID,
                token_prefix: TOKEN.substring(0, 5) + '...'
            });

            const response = await axios.post<RukassaCreatePaymentResponse>(
                RUKASSA_API_URL,
                paymentData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            console.log('Ответ Rukassa:', response.data);

            if (!response.data.url) {
                console.error('Ошибка ответа Rukassa:', response.data);
                throw new Error(response.data.message || 'Не удалось создать платёж');
            }

            // Добавляем параметры пользователя в URL
            const paymentUrl = `${response.data.url}&user_id=${userId}&credits=${package_.credits}`;
            return paymentUrl;

        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            if (axios.isAxiosError(error)) {
                console.error('Детали ошибки:', {
                    response: error.response?.data,
                    status: error.response?.status,
                    headers: error.response?.headers,
                    message: error.message,
                    code: error.code
                });
            }
            
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            ).catch(err => console.error('Ошибка при удалении платежа:', err));
            
            throw new Error('Не удалось создать платёж. Попробуйте позже.');
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
                    `✅ Оплата ${amount} ${curr?.symbol || currency} успешно получена!\nНа ваш счет зачислено ${credits} кредитов.`
                );
            } else if (data.payment_status === 'failed') {
                await this.bot.telegram.sendMessage(
                    user_id,
                    '❌ Оплата не была завершена. Попробуйте снова или выберите другой способ оплаты.'
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
    bot.command('buy', async (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🇷🇺 Рубли', 'currency_RUB')],
            [Markup.button.callback('🇺🇸 Доллары', 'currency_USD')],
            [Markup.button.callback('🇺🇿 Сум', 'currency_UZS')],
            [Markup.button.callback('🇰🇿 Тенге', 'currency_KZT')]
        ]);

        await ctx.reply(
            '💳 Выберите валюту для оплаты:',
            keyboard
        );
    });

    bot.action(/currency_(.+)/, async (ctx) => {
        const currency = ctx.match[1] as SupportedCurrency;
        const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
        
        if (!curr) {
            await ctx.reply('Неподдерживаемая валюта');
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

        await ctx.reply(
            `💳 Выберите пакет кредитов (цены в ${curr.name}):`,
            keyboard
        );

        await ctx.answerCbQuery();
    });

    bot.action(/buy_(\d+)_(.+)/, async (ctx) => {
        try {
            const packageId = parseInt(ctx.match[1]);
            const currency = ctx.match[2] as SupportedCurrency;
            const userId = ctx.from?.id;

            if (!userId) {
                throw new Error('ID пользователя не найден');
            }

            const rukassaPayment = new RukassaPayment(pool, bot);
            const paymentUrl = await rukassaPayment.createPayment(userId, packageId, currency);

            const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);

            await ctx.reply(
                `🔄 Для оплаты ${package_?.description} (${package_?.prices[currency]} ${curr?.symbol}) перейдите по ссылке:\n` +
                `${paymentUrl}\n\n` +
                'После оплаты кредиты будут автоматически зачислены на ваш счет.',
                { disable_web_page_preview: true }
            );
        } catch (error) {
            console.error('Ошибка при обработке платежа:', error);
            await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
        }
        await ctx.answerCbQuery();
    });
}

export function setupRukassaWebhook(app: express.Express, rukassaPayment: RukassaPayment): void {
    app.post('/rukassa/webhook', express.json(), async (req, res) => {
        try {
            console.log('Получен webhook от Rukassa:', req.body);
            await rukassaPayment.handleWebhook(req.body);
            res.json({ status: 'success' });
        } catch (error) {
            console.error('Ошибка обработки webhook от Rukassa:', error);
            res.status(400).json({ 
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });
}