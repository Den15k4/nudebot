import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { Pool } from 'pg';
import express from 'express';

// Основные конфигурационные параметры из переменных окружения
const SHOP_ID = process.env.SHOP_ID || '2660';
const TOKEN = process.env.TOKEN || '9876a82910927a2c9a43f34cb5ad2de7';
const RUKASSA_API_URL = 'https://lk.rukassa.pro/api/v1/create';
const WEBHOOK_URL = process.env.WEBHOOK_URL?.replace('/webhook', '') || 'https://nudebot-production.up.railway.app';

// Интерфейс для ответа от API Rukassa при создании платежа
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

// Интерфейс для данных, получаемых через webhook от Rukassa
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

// Интерфейс для цен в разных валютах
interface Price {
    [key: string]: number;
    RUB: number;
    KZT: number;
    UZS: number;
    CRYPTO: number;
}

// Поддерживаемые валюты
type SupportedCurrency = 'RUB' | 'KZT' | 'UZS' | 'CRYPTO';

// Интерфейс для описания валюты и её параметров
interface Currency {
    code: SupportedCurrency;
    symbol: string;
    name: string;
    method: string;
    minAmount: number;
    decimal_places: number;
}

// Интерфейс для пакетов кредитов
interface PaymentPackage {
    id: number;
    credits: number;
    prices: Price;
    description: string;
}

// Конфигурация поддерживаемых валют и методов оплаты
const SUPPORTED_CURRENCIES: Currency[] = [
    { 
        code: 'RUB', 
        symbol: '₽', 
        name: 'Visa/MC (RUB)', 
        method: 'card',
        minAmount: 300,
        decimal_places: 0
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Visa/MC (KZT)', 
        method: 'card_kzt',
        minAmount: 32500, // ≈650₽
        decimal_places: 0
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Visa/MC (UZS)', 
        method: 'card_uzs',
        minAmount: 86000, // ≈650₽
        decimal_places: 0
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Криптовалюта', 
        method: 'crypto',
        minAmount: 3,
        decimal_places: 2
    }
];

// Пакеты кредитов с ценами для каждой валюты
const CREDIT_PACKAGES: PaymentPackage[] = [
    // Базовые пакеты (RUB и CRYPTO)
    {
        id: 1,
        credits: 3,
        prices: {
            RUB: 300,      // 100₽ за генерацию
            KZT: 32500,    // Недоступно, мин. сумма
            UZS: 86000,    // Недоступно, мин. сумма
            CRYPTO: 3.00   // ~100₽ за генерацию
        },
        description: '3 генерации'
    },
    {
        id: 2,
        credits: 7,
        prices: {
            RUB: 600,      // ~85₽ за генерацию
            KZT: 58500,    // Недоступно
            UZS: 154800,   // Недоступно
            CRYPTO: 6.00   // ~85₽ за генерацию
        },
        description: '7 генераций'
    },
    {
        id: 3,
        credits: 15,
        prices: {
            RUB: 1200,     // 80₽ за генерацию
            KZT: 108000,   // ~80₽ за генерацию
            UZS: 286000,   // ~80₽ за генерацию
            CRYPTO: 12.00  // ~80₽ за генерацию
        },
        description: '15 генераций'
    },
    {
        id: 4,
        credits: 30,
        prices: {
            RUB: 2000,     // ~67₽ за генерацию
            KZT: 195000,   // ~65₽ за генерацию
            UZS: 516000,   // ~65₽ за генерацию
            CRYPTO: 20.00  // ~67₽ за генерацию
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

    // Инициализация таблицы платежей в базе данных
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

    // Форматирование суммы платежа согласно требованиям валюты
    formatAmount(amount: number, currency: SupportedCurrency): string {
        const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
        if (!curr) {
            throw new Error('Неподдерживаемая валюта');
        }

        if (curr.decimal_places === 0) {
            return Math.round(amount).toString();
        }

        return amount.toFixed(curr.decimal_places);
    }

    // Создание нового платежа
    async createPayment(userId: number, packageId: number, currency: SupportedCurrency = 'RUB'): Promise<string> {
        const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
        if (!package_) {
            throw new Error('Неверный ID пакета');
        }

        const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
        if (!curr) {
            throw new Error('Неподдерживаемая валюта');
        }

        // Проверка минимальной суммы
        if (package_.prices[currency] < curr.minAmount) {
            throw new Error(`Минимальная сумма для ${currency}: ${curr.minAmount} ${curr.symbol}`);
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        const amount = this.formatAmount(package_.prices[currency], currency);
        
        try {
            // Сохраняем информацию о платеже в базе
            await this.pool.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, $5, $6)',
                [userId, merchantOrderId, parseFloat(amount), package_.credits, 'pending', currency]
            );

            // Формируем данные для запроса к API
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
            
            // Добавляем дополнительную информацию
            formData.append('custom_fields', JSON.stringify({
                user_id: userId,
                package_id: packageId,
                credits: package_.credits,
                description: `${package_.description} для пользователя ${userId}`
            }));

            // Логируем параметры запроса
            console.log('Параметры запроса:', {
                url: RUKASSA_API_URL,
                data: { 
                    ...Object.fromEntries(formData),
                    token: '***hidden***'
                }
            });

            // Отправляем запрос в API
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
            
            // Удаляем неудачный платёж из базы
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

    // Обработка webhook от платёжной системы
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
                // Начисляем кредиты пользователю
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [credits, user_id]
                );

                const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата ${amount} ${curr?.symbol || currency} успешно получена!\n` +
                    `На ваш счет зачислено ${credits} кредитов.`
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

// Настройка команд бота для работы с платежами
export function setupPaymentCommands(bot: Telegraf, pool: Pool): void {
    // Команда /buy - показывает список доступных способов оплаты
    bot.command('buy', async (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 Visa/MC (RUB)', 'currency_RUB')],
            [Markup.button.callback('💳 Visa/MC (KZT)', 'currency_KZT')],
            [Markup.button.callback('💳 Visa/MC (UZS)', 'currency_UZS')],
            [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')]
        ]);

        await ctx.reply(
            '💳 Выберите способ оплаты:',
            keyboard
        );
    });

    // Обработчик выбора валюты
   bot.action(/currency_(.+)/, async (ctx) => {
       try {
           const currency = ctx.match[1] as SupportedCurrency;
           const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
           
           if (!curr) {
               await ctx.answerCbQuery('Неподдерживаемая валюта');
               return;
           }

           // Отфильтруем пакеты, доступные для выбранной валюты
           const availablePackages = CREDIT_PACKAGES.filter(pkg => 
               pkg.prices[currency] >= curr.minAmount
           );

           const keyboard = {
               inline_keyboard: availablePackages.map(pkg => [
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

   // Обработчик выбора пакета и создания платежа
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
           console.error('Ошибка при создании платежа:', error);
           await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
       }
   });
}

// Настройка обработчиков webhook'ов и страниц результата оплаты
export function setupRukassaWebhook(app: express.Express, rukassaPayment: RukassaPayment): void {
   // Обработчик webhook'а от Rukassa
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

   // Страница успешной оплаты
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

   // Страница неуспешной оплаты
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

   // Страница отмены оплаты
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

   // Эндпоинт проверки здоровья сервиса
   app.get('/health', (req, res) => {
       res.json({
           status: 'ok',
           timestamp: new Date().toISOString(),
           webhook_url: `${WEBHOOK_URL}/rukassa/webhook`
       });
   });
}