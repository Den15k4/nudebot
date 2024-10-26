import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import { Pool } from 'pg';
import express from 'express';

// Конфигурация Rukassa
const RUKASSA_SHOP_ID = process.env.RUKASSA_SHOP_ID || '';
const RUKASSA_SECRET_KEY = process.env.RUKASSA_SECRET_KEY || '';
const RUKASSA_API_URL = 'https://api.rukassa.is';

// Интерфейсы для Rukassa
interface PaymentPackage {
    id: number;
    credits: number;
    price: number;
    description: string;
}

interface RukassaCreatePaymentResponse {
    status: boolean;
    error?: string;
    pay_url?: string;
    order_id?: string;
}

interface RukassaWebhookBody {
    merchant_order_id: string;
    order_id: string;
    amount: string;
    sign: string;
    status: string;
    payment_method: string;
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

    private generateSign(params: Record<string, string>): string {
        const sortedKeys = Object.keys(params).sort();
        const values = sortedKeys.map(key => params[key]).join(':');
        const signString = `${values}:${RUKASSA_SECRET_KEY}`;
        console.log('Строка для подписи:', signString);
        return crypto
            .createHash('md5')
            .update(signString)
            .digest('hex');
    }

    private validateWebhookSign(data: RukassaWebhookBody): boolean {
        const params = {
            merchant_order_id: data.merchant_order_id,
            order_id: data.order_id,
            amount: data.amount,
            status: data.status
        };
        const calculatedSign = this.generateSign(params);
        console.log('Проверка подписи:', {
            calculated: calculatedSign,
            received: data.sign
        });
        return calculatedSign === data.sign;
    }

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

            console.log('Создание платежа:', {
                shop_id: RUKASSA_SHOP_ID,
                order_id: merchantOrderId,
                amount: package_.price,
                description: package_.description
            });

            // Создаем платеж в Rukassa
            const response = await axios.post<RukassaCreatePaymentResponse>(
                `${RUKASSA_API_URL}/api/v1/create`,
                {
                    shop_id: RUKASSA_SHOP_ID,
                    order_id: merchantOrderId,
                    amount: package_.price.toString(),
                    currency: 'RUB',
                    desc: package_.description,
                    method: 'all',
                    success_url: 'https://t.me/photowombot',
                    fail_url: 'https://t.me/photowombot'
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                }
            );

            console.log('Ответ Rukassa:', response.data);

            if (!response.data.status || !response.data.pay_url) {
                console.error('Ошибка ответа Rukassa:', response.data);
                throw new Error(response.data.error || 'Не удалось создать платёж');
            }

            return response.data.pay_url;
        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            if (axios.isAxiosError(error)) {
                console.error('Детали ошибки:', {
                    response: error.response?.data,
                    status: error.response?.status,
                    headers: error.response?.headers
                });
            }
            // Удаляем неудачную запись о платеже
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            );
            throw error;
        }
    }

    async handleWebhook(data: RukassaWebhookBody): Promise<void> {
        console.log('Получены данные webhook:', data);

        if (!this.validateWebhookSign(data)) {
            console.error('Неверная подпись webhook');
            throw new Error('Неверная подпись');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const paymentResult = await client.query(
                'UPDATE payments SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE merchant_order_id = $3 RETURNING user_id, credits',
                [data.status, data.order_id, data.merchant_order_id]
            );

            if (paymentResult.rows.length === 0) {
                throw new Error('Платёж не найден');
            }

            const { user_id, credits } = paymentResult.rows[0];

            // Если платеж успешен
            if (data.status === 'success') {
                console.log(`Начисление ${credits} кредитов пользователю ${user_id}`);
                
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [credits, user_id]
                );

                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата успешно получена!\nНа ваш счет зачислено ${credits} кредитов.`
                );
            } else if (data.status === 'fail') {
                // Если платеж не удался
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