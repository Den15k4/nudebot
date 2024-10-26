import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import { Pool } from 'pg';
import express from 'express';

// Конфигурация Rukassa
const RUKASSA_SHOP_ID = process.env.RUKASSA_SHOP_ID || '';
const RUKASSA_SECRET_KEY = process.env.RUKASSA_SECRET_KEY || '';
const RUKASSA_API_URL = 'https://lk.rukassa.io';

// Интерфейсы
interface PaymentPackage {
    id: number;
    credits: number;
    price: number;
    description: string;
}

interface RukassaCreatePaymentResponse {
    status: number;
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

// Пакеты кредитов
const CREDIT_PACKAGES: PaymentPackage[] = [
    { id: 1, credits: 5, price: 199, description: '5 кредитов' },
    { id: 2, credits: 10, price: 349, description: '10 кредитов' },
    { id: 3, credits: 20, price: 599, description: '20 кредитов' }
];

export class RukassaPayment {
    private pool: Pool;
    private bot: Telegraf;

    constructor(pool: Pool, bot: Telegraf) {
        this.pool = pool;
        this.bot = bot;
    }

    // Инициализация таблицы платежей
    async initPaymentsTable() {
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
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log('Таблица payments создана успешно');
        } catch (error) {
            console.error('Ошибка при создании таблицы payments:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Генерация подписи для Rukassa
    private generateSign(params: Record<string, string>): string {
        const sortedKeys = Object.keys(params).sort();
        const values = sortedKeys.map(key => params[key]).join('|');
        const signString = `${values}|${RUKASSA_SECRET_KEY}`;
        console.log('Строка для подписи:', signString);
        return crypto
            .createHash('md5')
            .update(signString)
            .digest('hex');
    }

    // Проверка подписи webhook
    private validateWebhookSign(data: RukassaWebhookBody): boolean {
        const params = {
            shop_id: data.shop_id,
            amount: data.amount,
            order_id: data.order_id,
            payment_status: data.payment_status,
            payment_method: data.payment_method,
            custom_fields: data.custom_fields,
            merchant_order_id: data.merchant_order_id
        };
        const calculatedSign = this.generateSign(params);
        console.log('Проверка подписи:', {
            calculated: calculatedSign,
            received: data.sign
        });
        return calculatedSign === data.sign;
    }

    // Создание платежа
    async createPayment(userId: number, packageId: number): Promise<string> {
        const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
        if (!package_) {
            throw new Error('Неверный ID пакета');
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        
        try {
            // Сохраняем информацию о платеже
            await this.pool.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status) VALUES ($1, $2, $3, $4, $5)',
                [userId, merchantOrderId, package_.price, package_.credits, 'pending']
            );

            // Подготавливаем данные для создания платежа
            const paymentData = {
                shop_id: RUKASSA_SHOP_ID,
                order_id: merchantOrderId,
                amount: package_.price.toString(),
                currency: 'RUB',
                receipt_items: [{
                    name: package_.description,
                    count: 1,
                    price: package_.price
                }],
                webhook_url: 'https://nudebot-production.up.railway.app/rukassa/webhook',
                custom_fields: JSON.stringify({ credits: package_.credits }),
                method: 'all',
                success_url: 'https://t.me/photowombot',
                fail_url: 'https://t.me/photowombot'
            };

            // Генерируем подпись для запроса
            const signParams = {
                shop_id: paymentData.shop_id,
                amount: paymentData.amount,
                order_id: paymentData.order_id,
                currency: paymentData.currency
            };
            const sign = this.generateSign(signParams);

            console.log('Создание платежа:', paymentData);

            // Отправляем запрос в Rukassa
            const response = await axios.post<RukassaCreatePaymentResponse>(
                `${RUKASSA_API_URL}/api/v1/create`,
                paymentData,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'Authorization': `Bearer ${RUKASSA_SECRET_KEY}`,
                        'Sign': sign
                    },
                    timeout: 10000
                }
            );

            console.log('Ответ Rukassa:', response.data);

            if (response.data.status !== 1 || !response.data.url) {
                console.error('Ошибка ответа Rukassa:', response.data);
                throw new Error(response.data.message || 'Не удалось создать платёж');
            }

            return response.data.url;
        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            if (axios.isAxiosError(error)) {
                console.error('Детали ошибки:', {
                    response: error.response?.data,
                    status: error.response?.status
                });
            }
            // Удаляем неудачную запись о платеже
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            ).catch(err => console.error('Ошибка при удалении платежа:', err));
            
            throw new Error('Не удалось создать платёж. Попробуйте позже.');
        }
    }

    // Обработка webhook от Rukassa
    async handleWebhook(data: RukassaWebhookBody): Promise<void> {
        console.log('Получены данные webhook:', data);

        if (!this.validateWebhookSign(data)) {
            throw new Error('Неверная подпись webhook');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const paymentResult = await client.query(
                'UPDATE payments SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE merchant_order_id = $3 RETURNING user_id, credits',
                [data.payment_status, data.order_id, data.merchant_order_id]
            );

            if (paymentResult.rows.length === 0) {
                throw new Error('Платёж не найден');
            }

            const { user_id, credits } = paymentResult.rows[0];

            if (data.payment_status === 'paid') {
                // Начисляем кредиты пользователю
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [credits, user_id]
                );

                // Отправляем уведомление об успешной оплате
                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата успешно получена!\nНа ваш счет зачислено ${credits} кредитов.`
                );
            } else if (data.payment_status === 'failed') {
                // Отправляем уведомление о неудачной оплате
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

    // Получение статуса платежа
    async getPaymentStatus(userId: number, merchantOrderId: string): Promise<string> {
        try {
            const result = await this.pool.query(
                'SELECT status FROM payments WHERE user_id = $1 AND merchant_order_id = $2',
                [userId, merchantOrderId]
            );
            return result.rows[0]?.status || 'unknown';
        } catch (error) {
            console.error('Ошибка при получении статуса платежа:', error);
            throw error;
        }
    }
}

// Настройка команд бота для платежей
export function setupPaymentCommands(bot: Telegraf) {
    bot.command('buy', async (ctx) => {
        const keyboard = Markup.inlineKeyboard(
            CREDIT_PACKAGES.map(pkg => [
                Markup.button.callback(
                    `${pkg.description} - ${pkg.price} ₽`,
                    `buy_${pkg.id}`
                )
            ])
        );

        await ctx.reply(
            '💳 Выберите пакет кредитов для покупки:',
            keyboard
        );
    });
}

// Настройка webhook для Rukassa
export function setupRukassaWebhook(app: express.Express, rukassaPayment: RukassaPayment) {
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