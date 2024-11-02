import { Pool } from 'pg';
import { ENV } from '../config/environment';
import { User, Payment, PhotoStats, AdminStats } from '../types/interfaces';

class DatabaseService {
    public pool: Pool;

    constructor() {
        this.pool = new Pool({
            connectionString: ENV.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false
            }
        });
    }

    async initTables(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Основная таблица пользователей
            await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    user_id BIGINT PRIMARY KEY,
                    username TEXT,
                    credits INT DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    last_used TIMESTAMPTZ,
                    pending_task_id TEXT,
                    accepted_rules BOOLEAN DEFAULT FALSE,
                    referrer_id BIGINT REFERENCES users(user_id),
                    referral_earnings DECIMAL DEFAULT 0
                );
            `);

            // Таблица платежей
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
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Таблица реферальных транзакций
            await client.query(`
                CREATE TABLE IF NOT EXISTS referral_transactions (
                    id SERIAL PRIMARY KEY,
                    referrer_id BIGINT REFERENCES users(user_id),
                    referral_id BIGINT REFERENCES users(user_id),
                    amount DECIMAL,
                    payment_id INTEGER REFERENCES payments(id),
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Таблица истории обработки фото
            await client.query(`
                CREATE TABLE IF NOT EXISTS photo_processing_history (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT REFERENCES users(user_id),
                    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN,
                    error_message TEXT,
                    processing_time INTEGER
                );
            `);

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async addUser(userId: number, username?: string): Promise<void> {
        try {
            await this.pool.query(
                `INSERT INTO users 
                (user_id, username, credits, accepted_rules) 
                VALUES ($1, $2, 0, FALSE) 
                ON CONFLICT (user_id) 
                DO UPDATE SET username = EXCLUDED.username`,
                [userId, username || 'anonymous']
            );
        } catch (error) {
            console.error('Error adding user:', error);
            throw error;
        }
    }

    async updateAcceptedRules(userId: number): Promise<void> {
        try {
            await this.pool.query(
                'UPDATE users SET accepted_rules = true WHERE user_id = $1',
                [userId]
            );
        } catch (error) {
            console.error('Error updating rules acceptance:', error);
            throw error;
        }
    }

    async hasAcceptedRules(userId: number): Promise<boolean> {
        const result = await this.pool.query(
            'SELECT accepted_rules FROM users WHERE user_id = $1',
            [userId]
        );
        return result.rows[0]?.accepted_rules || false;
    }

    async checkCredits(userId: number): Promise<number> {
        const result = await this.pool.query(
            'SELECT credits FROM users WHERE user_id = $1',
            [userId]
        );
        return result.rows[0]?.credits || 0;
    }

    async updateUserCredits(userId: number, credits: number): Promise<void> {
        await this.pool.query(
            'UPDATE users SET credits = credits + $1, last_used = CURRENT_TIMESTAMP WHERE user_id = $2',
            [credits, userId]
        );
    }

    async setUserPendingTask(userId: number, taskId: string | null): Promise<void> {
        await this.pool.query(
            'UPDATE users SET pending_task_id = $1 WHERE user_id = $2',
            [taskId, userId]
        );
    }

    async getUserByPendingTask(taskId: string): Promise<User | null> {
        const result = await this.pool.query<User>(
            'SELECT * FROM users WHERE pending_task_id = $1',
            [taskId]
        );
        return result.rows[0] || null;
    }

    async addReferral(userId: number, referrerId: number): Promise<void> {
        await this.pool.query(
            'UPDATE users SET referrer_id = $1 WHERE user_id = $2 AND referrer_id IS NULL',
            [referrerId, userId]
        );
    }

    async getReferralStats(userId: number): Promise<{ count: number; earnings: number }> {
        const result = await this.pool.query(
            'SELECT COUNT(*) as count, COALESCE(SUM(referral_earnings), 0) as earnings FROM users WHERE referrer_id = $1',
            [userId]
        );
        return {
            count: parseInt(result.rows[0].count),
            earnings: parseFloat(result.rows[0].earnings)
        };
    }

    async processReferralPayment(paymentId: number): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const payment = await client.query(
                'SELECT user_id, amount FROM payments WHERE id = $1 AND status = \'paid\'',
                [paymentId]
            );

            if (payment.rows.length > 0) {
                const referral = await client.query(
                    'SELECT referrer_id FROM users WHERE user_id = $1',
                    [payment.rows[0].user_id]
                );

                if (referral.rows[0]?.referrer_id) {
                    const referralAmount = payment.rows[0].amount * 0.5;
                    
                    await client.query(
                        'UPDATE users SET referral_earnings = referral_earnings + $1 WHERE user_id = $2',
                        [referralAmount, referral.rows[0].referrer_id]
                    );

                    await client.query(
                        'INSERT INTO referral_transactions (referrer_id, referral_id, amount, payment_id) VALUES ($1, $2, $3, $4)',
                        [referral.rows[0].referrer_id, payment.rows[0].user_id, referralAmount, paymentId]
                    );
                }
            }

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async createPayment(userId: number, merchantOrderId: string, amount: number, credits: number, currency: string): Promise<void> {
        await this.pool.query(
            'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, \'pending\', $5)',
            [userId, merchantOrderId, amount, credits, currency]
        );
    }

    async getPaymentByMerchantId(merchantOrderId: string): Promise<Payment | null> {
        const result = await this.pool.query<Payment>(
            'SELECT * FROM payments WHERE merchant_order_id = $1',
            [merchantOrderId]
        );
        return result.rows[0] || null;
    }

    async updatePaymentStatus(id: number, status: string, orderId: string): Promise<void> {
        await this.pool.query(
            'UPDATE payments SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [status, orderId, id]
        );
    }

    async deletePayment(merchantOrderId: string): Promise<void> {
        await this.pool.query(
            'DELETE FROM payments WHERE merchant_order_id = $1',
            [merchantOrderId]
        );
    }

    async updatePhotoProcessingStats(userId: number, success: boolean, errorMessage?: string, processingTime?: number): Promise<void> {
        await this.pool.query(
            'INSERT INTO photo_processing_history (user_id, success, error_message, processing_time) VALUES ($1, $2, $3, $4)',
            [userId, success, errorMessage, processingTime]
        );
    }

    async getPhotoStats(userId: number): Promise<PhotoStats> {
        const result = await this.pool.query(`
            SELECT 
                COUNT(*) as total_processed,
                COUNT(CASE WHEN success = true THEN 1 END) as successful_photos,
                COUNT(CASE WHEN success = false THEN 1 END) as failed_photos,
                COALESCE(AVG(processing_time), 0) as avg_processing_time
            FROM photo_processing_history
            WHERE user_id = $1
        `, [userId]);
        
        return result.rows[0] || {
            total_processed: 0,
            successful_photos: 0,
            failed_photos: 0,
            avg_processing_time: 0
        };
    }

    async getAdminStats(): Promise<AdminStats> {
        const client = await this.pool.connect();
        try {
            const [users, photos, payments] = await Promise.all([
                client.query(`
                    SELECT 
                        COUNT(*) as total,
                        COUNT(CASE WHEN last_used >= NOW() - INTERVAL '24 hours' THEN 1 END) as active_24h,
                        COUNT(DISTINCT user_id) as paid
                    FROM users u
                    LEFT JOIN payments p ON u.user_id = p.user_id WHERE p.status = 'paid'
                `),
                client.query(`
                    SELECT 
                        COUNT(*) as total_processed,
                        COUNT(CASE WHEN success = true THEN 1 END) as successful,
                        COUNT(CASE WHEN success = false THEN 1 END) as failed
                    FROM photo_processing_history
                `),
                client.query(`
                    SELECT COALESCE(SUM(amount), 0) as total_amount
                    FROM payments
                    WHERE status = 'paid'
                `)
            ]);

            return {
                users: {
                    total: parseInt(users.rows[0].total),
                    active_24h: parseInt(users.rows[0].active_24h),
                    paid: parseInt(users.rows[0].paid)
                },
                photos: {
                    total_processed: parseInt(photos.rows[0].total_processed),
                    successful: parseInt(photos.rows[0].successful),
                    failed: parseInt(photos.rows[0].failed)
                },
                payments: {
                    total_amount: parseFloat(payments.rows[0].total_amount)
                }
            };
        } finally {
            client.release();
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

export const db = new DatabaseService();