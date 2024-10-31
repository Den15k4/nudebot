import { Pool } from 'pg';
import { ENV } from '../config/environment';
import { User, Payment } from '../types/interfaces';

class DatabaseService {
    private pool: Pool;

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

            // Таблица рассылок
            await client.query(`
                CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
                    id TEXT PRIMARY KEY,
                    message TEXT,
                    image_path TEXT,
                    scheduled_time TIMESTAMPTZ,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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

    // Методы для работы с пользователями
    async addUser(userId: number, username?: string): Promise<void> {
        await this.pool.query(
            'INSERT INTO users (user_id, username, credits, accepted_rules) VALUES ($1, $2, 0, FALSE) ON CONFLICT (user_id) DO NOTHING',
            [userId, username || 'anonymous']
        );
    }

    async hasAcceptedRules(userId: number): Promise<boolean> {
        const result = await this.pool.query(
            'SELECT accepted_rules FROM users WHERE user_id = $1',
            [userId]
        );
        return result.rows[0]?.accepted_rules || false;
    }

    async getAllUsers(): Promise<{ user_id: number }[]> {
        const result = await this.pool.query(
            'SELECT user_id FROM users WHERE accepted_rules = TRUE'
        );
        return result.rows;
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

    // Методы для работы с рефералами
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
                    const referralAmount = payment.rows[0].amount * 0.5; // 50% от оплаты
                    
                    // Начисляем бонус рефереру
                    await client.query(
                        'UPDATE users SET referral_earnings = referral_earnings + $1 WHERE user_id = $2',
                        [referralAmount, referral.rows[0].referrer_id]
                    );

                    // Записываем транзакцию
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

    async getRecentReferralTransactions(userId: number, limit: number = 5): Promise<any[]> {
        const result = await this.pool.query(
            `SELECT 
                u.username,
                rt.amount,
                rt.created_at
            FROM referral_transactions rt
            JOIN users u ON u.user_id = rt.referral_id
            WHERE rt.referrer_id = $1
            ORDER BY rt.created_at DESC
            LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    }

    // Методы для работы с платежами
    async createPayment(
        userId: number, 
        merchantOrderId: string, 
        amount: number, 
        credits: number, 
        currency: string
    ): Promise<void> {
        await this.pool.query(`
            INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) 
            VALUES ($1, $2, $3, $4, 'pending', $5)`,
            [userId, merchantOrderId, amount, credits, currency]
        );
    }

    async deletePayment(merchantOrderId: string): Promise<void> {
        await this.pool.query(
            'DELETE FROM payments WHERE merchant_order_id = $1',
            [merchantOrderId]
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

    // Методы для работы с рассылками
    async getScheduledBroadcasts() {
        const result = await this.pool.query(`
            SELECT * FROM scheduled_broadcasts 
            WHERE scheduled_time > NOW()
            ORDER BY scheduled_time ASC
        `);
        return result.rows;
    }

    // Методы для статистики
    async getStats() {
        const [totalUsers, activeToday, creditsStats] = await Promise.all([
            this.pool.query('SELECT COUNT(*) FROM users WHERE accepted_rules = TRUE'),
            this.pool.query(`
                SELECT COUNT(DISTINCT user_id) 
                FROM users 
                WHERE last_used >= NOW() - INTERVAL '24 hours'
            `),
            this.pool.query(`
                SELECT 
                    COUNT(*) as total_users,
                    SUM(credits) as total_credits,
                    AVG(credits) as avg_credits,
                    MAX(credits) as max_credits
                FROM users
                WHERE accepted_rules = TRUE
            `)
        ]);

        return {
            totalUsers: parseInt(totalUsers.rows[0].count),
            activeToday: parseInt(activeToday.rows[0].count),
            creditsStats: creditsStats.rows[0]
        };
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

export const db = new DatabaseService();