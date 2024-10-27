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

// Поддерживаемые валюты и методы оплаты
interface Price {
    [key: string]: number;
    RUB: number;   // CARD для RUB
    KZT: number;   // CARD_KZT для Казахстана
    UZS: number;   // CARD_UZS для Узбекистана
    CRYPTO: number; // CRYPTO для криптовалют
}

type SupportedCurrency = 'RUB' | 'KZT' | 'UZS' | 'CRYPTO';

interface Currency {
    code: SupportedCurrency;
    symbol: string;
    name: string;
    method: string; // Код метода оплаты
    minAmount: number; // Минимальная сумма для метода
}

// Обновленные поддерживаемые валюты с методами оплаты
const SUPPORTED_CURRENCIES: Currency[] = [
    { 
        code: 'RUB', 
        symbol: '₽', 
        name: 'Рубли', 
        method: 'CARD',
        minAmount: 300 // Минимум 300 рублей
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Тенге', 
        method: 'CARD_KZT',
        minAmount: 550 // Минимум 550 тенге
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Сум', 
        method: 'CARD_UZS',
        minAmount: 6350 // Минимум 6350 сум
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Криптовалюта', 
        method: 'CRYPTO',
        minAmount: 1.00 // Минимум 1 USDT
    }
];

// Обновленные пакеты с учетом минимальных сумм
const CREDIT_PACKAGES: PaymentPackage[] = [
    {
        id: 1,
        credits: 1,
        prices: {
            RUB: 300,     // Минимум 300₽
            KZT: 550,     // Минимум 550₸
            UZS: 6350,    // Минимум 6350 сум
            CRYPTO: 1.00  // Минимум 1 USDT
        },
        description: '1 генерация'
    },
    {
        id: 2,
        credits: 3,
        prices: {
            RUB: 600,     // 600₽
            KZT: 1100,    // 1100₸
            UZS: 12700,   // 12700 сум
            CRYPTO: 2.00  // 2 USDT
        },
        description: '3 генерации'
    },
    {
        id: 3,
        credits: 10,
        prices: {
            RUB: 1500,    // 1500₽
            KZT: 2750,    // 2750₸
            UZS: 31750,   // 31750 сум
            CRYPTO: 5.00  // 5 USDT
        },
        description: '10 генераций'
    }
];

// Обновляем метод createPayment с учетом методов оплаты
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

        const paymentData = {
            shop_id: SHOP_ID,
            token: TOKEN,
            order_id: merchantOrderId,
            amount: amount,
            currency: currency,
            method: curr.method // Добавляем метод оплаты
        };

        console.log('Request details:', {
            url: RUKASSA_API_URL,
            data: paymentData,
            shop_id: SHOP_ID,
            token_prefix: TOKEN.substring(0, 5) + '...'
        });

        const response = await axios.post<RukassaCreatePaymentResponse>(
            RUKASSA_API_URL,
            paymentData,
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('Ответ Rukassa:', response.data);

        if (!response.data.url) {
            console.error('Ошибка ответа Rukassa:', response.data);
            throw new Error(response.data.message || 'Не удалось создать платёж');
        }

        return response.data.url;
    
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
        const keyboard = {
            inline_keyboard: [
                [Markup.button.callback('🇷🇺 Рубли', 'currency_RUB')],
                [Markup.button.callback('🇺🇸 Доллары', 'currency_USD')],
                [Markup.button.callback('🇺🇿 Сум', 'currency_UZS')],
                [Markup.button.callback('🇰🇿 Тенге', 'currency_KZT')]
            ]
        };

        await ctx.reply(
            '💳 Выберите валюту для оплаты:',
            { reply_markup: keyboard }
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
                {
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            try {
                await ctx.answerCbQuery();
            } catch {}
            console.error('Ошибка при выборе валюты:', error);
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
                'После оплаты кредиты будут автоматически зачислены на ваш счет.',
                { disable_web_page_preview: true }
            );
        } catch (error) {
            try {
                await ctx.answerCbQuery();
            } catch {}
            console.error('Ошибка при обработке платежа:', error);
            await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
        }   
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