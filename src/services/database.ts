import { Pool, PoolClient } from 'pg';
import { ENV } from '../config/environment';
import { 
    User, 
    Payment, 
    PhotoStats, 
    AdminStats, 
    TransactionError,
    ReferralTransaction
} from '../types/interfaces';
import { logger } from '../index';

class DatabaseService {
    public pool: Pool;
    private readonly RETRY_ATTEMPTS = 3;
    private readonly RETRY_DELAY = 1000;

    constructor() {
        this.pool = new Pool({
            connectionString: ENV.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false
            },
            max: ENV.DB_MAX_CONNECTIONS,
            idleTimeoutMillis: ENV.DB_IDLE_TIMEOUT,
            connectionTimeoutMillis: 2000
        });

        this.pool.on('error', (err) => {
            logger.error('Unexpected error on idle client', err);
        });
    }

    private async withTransaction<T>(
        callback: (client: PoolClient) => Promise<T>
    ): Promise<T> {
        const client = await this.pool.connect();
        let released = false;

        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                logger.error('Ошибка при откате транзакции:', rollbackError);
            }
            throw error;
        } finally {
            if (!released) {
                released = true;
                client.release();
            }
        }
    }

    async initTables(): Promise<void> {
        return this.withTransaction(async (client) => {
            // Создание таблицы пользователей
            await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    user_id BIGINT PRIMARY KEY,
                    username TEXT,
                    credits INT DEFAULT 1,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    last_used TIMESTAMPTZ,
                    pending_task_id TEXT,
                    referral_id BIGINT,
                    total_referral_earnings DECIMAL DEFAULT 0,
                    accepted_rules BOOLEAN DEFAULT FALSE
                );
                
                CREATE INDEX IF NOT EXISTS idx_users_last_used ON users(last_used);
                CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_id);
                CREATE INDEX IF NOT EXISTS idx_users_pending_task ON users(pending_task_id);
            `);

            // Создание таблицы платежей
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
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    payment_method TEXT,
                    error_message TEXT
                );
                
                CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
                CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
            `);

            // Создание таблицы реферальных выводов
            await client.query(`
                CREATE TABLE IF NOT EXISTS referral_withdrawals (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT REFERENCES users(user_id),
                    amount DECIMAL NOT NULL,
                    status TEXT DEFAULT 'pending',
                    payment_details JSONB,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    processed_at TIMESTAMPTZ
                );
                
                CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON referral_withdrawals(status);
            `);

            // Создание таблицы реферальных начислений
            await client.query(`
                CREATE TABLE IF NOT EXISTS referral_earnings (
                    id SERIAL PRIMARY KEY,
                    referrer_id BIGINT REFERENCES users(user_id),
                    referred_id BIGINT REFERENCES users(user_id),
                    payment_id INTEGER REFERENCES payments(id),
                    amount DECIMAL NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_earnings_referrer ON referral_earnings(referrer_id);
            `);

            // Создание таблицы истории обработки фото
            await client.query(`
                CREATE TABLE IF NOT EXISTS photo_processing_history (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT REFERENCES users(user_id),
                    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN,
                    error_message TEXT,
                    processing_time INTEGER,
                    credits_used INTEGER DEFAULT 1,
                    task_id TEXT
                );
                
                CREATE INDEX IF NOT EXISTS idx_photo_user_id ON photo_processing_history(user_id);
                CREATE INDEX IF NOT EXISTS idx_photo_success ON photo_processing_history(success);
            `);

            logger.info('Таблицы базы данных успешно инициализированы');
        });
    }

    // Методы работы с пользователями
    async addUser(userId: number, username?: string, referrerId?: number): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                const result = await client.query(
                    'SELECT user_id FROM users WHERE user_id = $1',
                    [userId]
                );

                if (result.rows.length === 0) {
                    await client.query(
                        `INSERT INTO users (user_id, username, credits, referral_id) 
                         VALUES ($1, $2, 1, $3)`,
                        [userId, username || 'anonymous', referrerId]
                    );
                    logger.info(`Добавлен новый пользователь: ${userId}`);
                }
            });
        } catch (error) {
            logger.error('Ошибка при добавлении пользователя:', error);
            throw error;
        }
    }

    async checkCredits(userId: number): Promise<number> {
        try {
            const result = await this.pool.query(
                'SELECT credits FROM users WHERE user_id = $1',
                [userId]
            );
            return result.rows[0]?.credits || 0;
        } catch (error) {
            logger.error('Ошибка при проверке кредитов:', error);
            throw error;
        }
    }

    async updateUserCredits(userId: number, credits: number): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                const currentBalance = await client.query(
                    'SELECT credits FROM users WHERE user_id = $1 FOR UPDATE',
                    [userId]
                );

                if (currentBalance.rows[0].credits + credits < 0) {
                    throw new TransactionError('Недостаточно кредитов');
                }

                await client.query(
                    `UPDATE users 
                     SET credits = credits + $1, 
                         last_used = CURRENT_TIMESTAMP 
                     WHERE user_id = $2`,
                    [credits, userId]
                );
            });
        } catch (error) {
            logger.error('Ошибка при обновлении кредитов:', error);
            throw error;
        }
    }

    // Методы для обработки фото
    async setUserPendingTask(userId: number, taskId: string | null): Promise<void> {
        try {
            await this.pool.query(
                'UPDATE users SET pending_task_id = $1 WHERE user_id = $2',
                [taskId, userId]
            );
        } catch (error) {
            logger.error('Ошибка при установке pending task:', error);
            throw error;
        }
    }

    async getUserByPendingTask(taskId: string): Promise<User | null> {
        try {
            const result = await this.pool.query<User>(
                'SELECT * FROM users WHERE pending_task_id = $1',
                [taskId]
            );
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Ошибка при поиске пользователя по taskId:', error);
            throw error;
        }
    }

    // Методы реферальной системы
    async getReferralStats(userId: number): Promise<{ count: number; earnings: number }> {
        try {
            const result = await this.pool.query(`
                SELECT 
                    COUNT(DISTINCT u.user_id) as count,
                    COALESCE(SUM(re.amount), 0) as earnings
                FROM users u
                LEFT JOIN referral_earnings re ON re.referrer_id = $1
                WHERE u.referral_id = $1
            `, [userId]);

            return {
                count: parseInt(result.rows[0].count || '0'),
                earnings: parseFloat(result.rows[0].earnings || '0')
            };
        } catch (error) {
            logger.error('Ошибка при получении реферальной статистики:', error);
            throw error;
        }
    }

    async addReferral(userId: number, referrerId: number): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                // Проверяем существование реферера
                const referrer = await client.query(
                    'SELECT user_id FROM users WHERE user_id = $1',
                    [referrerId]
                );

                if (referrer.rows.length === 0) {
                    throw new Error('Реферер не найден');
                }

                // Проверяем, что у пользователя еще нет реферера
                const user = await client.query(
                    'SELECT referral_id FROM users WHERE user_id = $1',
                    [userId]
                );

                if (user.rows[0]?.referral_id) {
                    throw new Error('У пользователя уже есть реферер');
                }

                // Добавляем реферальную связь
                await client.query(
                    'UPDATE users SET referral_id = $1 WHERE user_id = $2',
                    [referrerId, userId]
                );

                logger.info('Добавлен реферал:', { userId, referrerId });
            });
        } catch (error) {
            logger.error('Ошибка при добавлении реферала:', error);
            throw error;
        }
    }

    async processReferralPayment(paymentId: number): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                const payment = await client.query(`
                    SELECT p.*, u.referral_id 
                    FROM payments p
                    JOIN users u ON u.user_id = p.user_id
                    WHERE p.id = $1 AND p.status = 'paid'
                `, [paymentId]);

                if (payment.rows.length > 0 && payment.rows[0].referral_id) {
                    const referralAmount = payment.rows[0].amount * 0.5; // 50% от платежа
                    
                    // Обновляем баланс реферера
                    await client.query(
                        'UPDATE users SET total_referral_earnings = total_referral_earnings + $1 WHERE user_id = $2',
                        [referralAmount, payment.rows[0].referral_id]
                    );

                    // Записываем начисление
                    await client.query(
                        `INSERT INTO referral_earnings 
                         (referrer_id, referred_id, payment_id, amount) 
                         VALUES ($1, $2, $3, $4)`,
                        [payment.rows[0].referral_id, payment.rows[0].user_id, paymentId, referralAmount]
                    );

                    logger.info('Обработан реферальный платеж:', {
                        paymentId,
                        referrerId: payment.rows[0].referral_id,
                        amount: referralAmount
                    });
                }
            });
        } catch (error) {
            logger.error('Ошибка при обработке реферального платежа:', error);
            throw error;
        }
    }

    async getReferralWithdrawals(userId: number): Promise<any[]> {
        try {
            const result = await this.pool.query(`
                SELECT * FROM referral_withdrawals 
                WHERE user_id = $1 
                ORDER BY created_at DESC 
                LIMIT 10
            `, [userId]);
            return result.rows;
        } catch (error) {
            logger.error('Ошибка при получении истории выводов:', error);
            throw error;
        }
    }

    async createWithdrawalRequest(
        userId: number, 
        amount: number, 
        paymentDetails: any
    ): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                const user = await client.query(
                    'SELECT total_referral_earnings FROM users WHERE user_id = $1 FOR UPDATE',
                    [userId]
                );

                if (!user.rows[0] || user.rows[0].total_referral_earnings < amount) {
                    throw new Error('Недостаточно средств для вывода');
                }

                await client.query(
                    `INSERT INTO referral_withdrawals 
                     (user_id, amount, payment_details, status) 
                     VALUES ($1, $2, $3, 'pending')`,
                    [userId, amount, paymentDetails]
                );

                await client.query(
                    'UPDATE users SET total_referral_earnings = total_referral_earnings - $1 WHERE user_id = $2',
                    [amount, userId]
                );
            });
        } catch (error) {
            logger.error('Ошибка при создании заявки на вывод:', error);
            throw error;
        }
    }

    // Методы для работы с платежами
    async createPayment(
        userId: number,
        merchantOrderId: string,
        amount: number,
        credits: number,
        currency: string
    ): Promise<void> {
        try {
            await this.pool.query(
                `INSERT INTO payments 
                 (user_id, merchant_order_id, amount, credits, status, currency) 
                 VALUES ($1, $2, $3, $4, 'pending', $5)`,
                [userId, merchantOrderId, amount, credits, currency]
            );
        } catch (error) {
            logger.error('Ошибка при создании платежа:', error);
            throw error;
        }
    }

    async getPaymentByMerchantId(merchantOrderId: string): Promise<Payment | null> {
        try {
            const result = await this.pool.query<Payment>(
                'SELECT * FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            );
            return result.rows[0] || null;
        } catch (error) {
            logger.error('Ошибка при поиске платежа:', error);
            throw error;
        }
    }

    async deletePayment(merchantOrderId: string): Promise<void> {
        try {
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            );
        } catch (error) {
            logger.error('Ошибка при удалении платежа:', error);
            throw error;
        }
    }

    async updatePaymentStatus(
        id: number,
        status: string,
        orderId: string
    ): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                await client.query(
                    `UPDATE payments 
                     SET status = $1, 
                         order_id = $2, 
                         updated_at = CURRENT_TIMESTAMP 
                     WHERE id = $3`,
                    [status, orderId, id]
                );

                if (status === 'paid') {
                    const payment = await client.query(
                        'SELECT user_id, credits FROM payments WHERE id = $1',
                        [id]
                    );
                    
                    if (payment.rows.length > 0) {
                        await this.updateUserCredits(
                            payment.rows[0].user_id,
                            payment.rows[0].credits
                        );
                    }
                }
            });
        } catch (error) {
            logger.error('Ошибка при обновлении статуса платежа:', error);
            throw error;
        }
    }

    // Методы для статистики и администрирования
    async getAdminStats(): Promise<AdminStats> {
        try {
            const [usersStats, photoStats, paymentStats] = await Promise.all([
                this.pool.query(`
                    SELECT 
                        COUNT(DISTINCT user_id) as total,
                        COUNT(DISTINCT CASE WHEN last_used >= NOW() - INTERVAL '24 hours' 
                            THEN user_id END) as active_24h,
                        COUNT(DISTINCT CASE WHEN total_spent > 0 
                            THEN user_id END) as paid
                    FROM users
                `),
                this.pool.query(`
                    SELECT 
                        COUNT(*) as total_processed,
                        COUNT(CASE WHEN success THEN 1 END) as successful,
                        COUNT(CASE WHEN NOT success THEN 1 END) as failed
                    FROM photo_processing_history
                `),
                this.pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total_amount
                    FROM payments 
                    WHERE status = 'paid'
                `)
            ]);

            return {
                users: {
                    total: parseInt(usersStats.rows[0].total),
                    active_24h: parseInt(usersStats.rows[0].active_24h),
                    paid: parseInt(usersStats.rows[0].paid)
                },
                photos: {
                    total_processed: parseInt(photoStats.rows[0].total_processed),
                    successful: parseInt(photoStats.rows[0].successful),
                    failed: parseInt(photoStats.rows[0].failed)
                },
                payments: {
                    total_amount: parseFloat(paymentStats.rows[0].total_amount)
                }
            };
        } catch (error) {
            logger.error('Ошибка при получении админ-статистики:', error);
            throw error;
        }
    }

    // Служебные методы
    async close(): Promise<void> {
        try {
            await this.pool.end();
            logger.info('Соединение с базой данных закрыто');
        } catch (error) {
            logger.error('Ошибка при закрытии соединения с БД:', error);
            throw error;
        }
    }

    async healthCheck(): Promise<boolean> {
        try {
            await this.pool.query('SELECT 1');
            return true;
        } catch (error) {
            logger.error('Ошибка при проверке здоровья БД:', error);
            return false;
        }
    }
}

export const db = new DatabaseService();