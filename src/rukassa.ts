import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import { Pool } from 'pg';
import express from 'express';

const RUKASSA_SHOP_ID = process.env.RUKASSA_SHOP_ID || '';
const RUKASSA_SECRET_KEY = process.env.RUKASSA_SECRET_KEY || '';

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
        return crypto
            .createHash('md5')
            .update(`${values}:${RUKASSA_SECRET_KEY}`)
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
        return calculatedSign === data.sign;
    }

    async createPayment(userId: number, packageId: number): Promise<string> {
        const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
        if (!package_) {
            throw new Error('Неверный ID пакета');
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        
        try {
            await this.pool.query(
                'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status) VALUES ($1, $2, $3, $4, $5)',
                [userId, merchantOrderId, package_.price, package_.credits, 'pending']
            );

            const response = await axios.post<RukassaCreatePaymentResponse>(
                'https://payment.rukassa.is/api/v1/create',
                {
                    shop_id: RUKASSA_SHOP_ID,
                    order_id: merchantOrderId,
                    amount: package_.price.toString(),
                    currency: 'RUB',
                    desc: package_.description,
                    method: 'all'
                }
            );

            if (!response.data.status || !response.data.pay_url) {
                throw new Error(response.data.error || 'Не удалось создать платёж');
            }

            return response.data.pay_url;
        } catch (error) {
            console.error('Ошибка при создании платежа:', error);
            throw error;
        }
    }

    async handleWebhook(data: RukassaWebhookBody): Promise<void> {
        if (!this.validateWebhookSign(data)) {
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

            if (data.status === 'success') {
                await client.query(
                    'UPDATE users SET credits = credits + $1 WHERE user_id = $2',
                    [credits, user_id]
                );

                await this.bot.telegram.sendMessage(
                    user_id,
                    `✅ Оплата успешно получена!\nНа ваш счет зачислено ${credits} кредитов.`
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
