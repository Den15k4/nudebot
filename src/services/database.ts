import { Pool, PoolClient } from 'pg';
import { ENV } from '../config/environment';
import { User, Payment, PhotoStats, AdminStats, TransactionError } from '../types/interfaces';
import { logger } from '../index';

class DatabaseService {
    public pool: Pool;
    private readonly RETRY_ATTEMPTS = 3;
    private readonly RETRY_DELAY = 1000; // 1 секунда

    constructor() {
        this.pool = new Pool({
            connectionString: ENV.DATABASE_URL,
            ssl: {
                rejectUnauthorized: false
            },
            max: 20, // максимум соединений
            idleTimeoutMillis: 30000, // timeout неактивного соединения
            connectionTimeoutMillis: 2000 // timeout подключения
        });

        // Обработка ошибок пула
        this.pool.on('error', (err) => {
            logger.error('Unexpected error on idle client', err);
        });
    }

    // Вспомогательная функция для выполнения транзакций с повторными попытками
    private async withTransaction<T>(
        callback: (client: PoolClient) => Promise<T>
    ): Promise<T> {
        const client = await this.pool.connect();
        let attempts = 0;
        
        while (attempts < this.RETRY_ATTEMPTS) {
            try {
                await client.query('BEGIN');
                const result = await callback(client);
                await client.query('COMMIT');
                return result;
            } catch (error) {
                await client.query('ROLLBACK');
                
                if (error instanceof TransactionError || attempts === this.RETRY_ATTEMPTS - 1) {
                    throw error;
                }
                
                attempts++;
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
            } finally {
                client.release();
            }
        }
        
        throw new Error('Превышено максимальное количество попыток транзакции');
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
                    referral_earnings DECIMAL DEFAULT 0,
                    photos_processed INTEGER DEFAULT 0,
                    total_spent DECIMAL DEFAULT 0,
                    last_notification_read TIMESTAMPTZ
                );
                
                -- Индексы для оптимизации
                CREATE INDEX IF NOT EXISTS idx_users_last_used ON users(last_used);
                CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
                CREATE INDEX IF NOT EXISTS idx_users_pending_task ON users(pending_task_id);
                CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
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
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    payment_method TEXT,
                    error_message TEXT
                );
                
                -- Индексы для платежей
                CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
                CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
                CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
            `);

            // Таблица реферальных транзакций
            await client.query(`
                CREATE TABLE IF NOT EXISTS referral_transactions (
                    id SERIAL PRIMARY KEY,
                    referrer_id BIGINT REFERENCES users(user_id),
                    referral_id BIGINT REFERENCES users(user_id),
                    amount DECIMAL,
                    payment_id INTEGER REFERENCES payments(id),
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    status TEXT DEFAULT 'pending',
                    processed_at TIMESTAMPTZ
                );
                
                -- Индексы для рефералов
                CREATE INDEX IF NOT EXISTS idx_ref_trans_referrer ON referral_transactions(referrer_id);
                CREATE INDEX IF NOT EXISTS idx_ref_trans_referral ON referral_transactions(referral_id);
                CREATE INDEX IF NOT EXISTS idx_ref_trans_status ON referral_transactions(status);
            `);

            // Таблица истории обработки фото
            await client.query(`
                CREATE TABLE IF NOT EXISTS photo_processing_history (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT REFERENCES users(user_id),
                    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN,
                    error_message TEXT,
                    processing_time INTEGER,
                    credits_used INTEGER DEFAULT 1,
                    original_file_size BIGINT,
                    result_file_size BIGINT,
                    api_response_code TEXT
                );
                
                -- Индексы для истории обработки
                CREATE INDEX IF NOT EXISTS idx_photo_user_id ON photo_processing_history(user_id);
                CREATE INDEX IF NOT EXISTS idx_photo_processed_at ON photo_processing_history(processed_at);
                CREATE INDEX IF NOT EXISTS idx_photo_success ON photo_processing_history(success);
            `);

            await client.query('COMMIT');
            logger.info('Таблицы базы данных успешно инициализированы');
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error('Ошибка при инициализации таблиц:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    // Методы работы с пользователями
    async addUser(userId: number, username?: string): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                const result = await client.query(
                    'SELECT user_id FROM users WHERE user_id = $1',
                    [userId]
                );

                if (result.rows.length === 0) {
                    await client.query(
                        `INSERT INTO users (user_id, username, credits, accepted_rules) 
                         VALUES ($1, $2, 0, FALSE)`,
                        [userId, username || 'anonymous']
                    );
                    logger.info(`Добавлен новый пользователь: ${userId}`);
                }
            });
        } catch (error) {
            logger.error('Ошибка при добавлении пользователя:', error);
            throw error;
        }
    }

    // Методы проверки и обновления статуса пользователя
    async hasAcceptedRules(userId: number): Promise<boolean> {
        try {
            const result = await this.pool.query(
                'SELECT accepted_rules FROM users WHERE user_id = $1',
                [userId]
            );
            return result.rows[0]?.accepted_rules || false;
        } catch (error) {
            logger.error('Ошибка при проверке правил:', error);
            throw error;
        }
    }

    async getAllUsers(): Promise<{ user_id: number }[]> {
        try {
            const result = await this.pool.query(
                'SELECT user_id FROM users WHERE accepted_rules = TRUE'
            );
            return result.rows;
        } catch (error) {
            logger.error('Ошибка при получении списка пользователей:', error);
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
                // Проверяем текущий баланс
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

                // Логируем изменение баланса
                await client.query(
                    `INSERT INTO credit_history (user_id, amount, operation_type, balance_after)
                     VALUES ($1, $2, $3, $4)`,
                    [
                        userId,
                        credits,
                        credits > 0 ? 'credit' : 'debit',
                        currentBalance.rows[0].credits + credits
                    ]
                );
            });
        } catch (error) {
            logger.error('Ошибка при обновлении кредитов:', error);
            throw error;
        }
    }

    // Методы работы с задачами обработки фото
    async setUserPendingTask(userId: number, taskId: string | null): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                await client.query(
                    'UPDATE users SET pending_task_id = $1 WHERE user_id = $2',
                    [taskId, userId]
                );

                if (taskId) {
                    await client.query(
                        `INSERT INTO task_history (user_id, task_id, status)
                         VALUES ($1, $2, 'pending')`,
                        [userId, taskId]
                    );
                }
            });
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

    // Методы работы с рефералами
    async addReferral(userId: number, referrerId: number): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                // Проверяем, что referrerId существует
                const referrer = await client.query(
                    'SELECT user_id FROM users WHERE user_id = $1',
                    [referrerId]
                );

                if (referrer.rows.length === 0) {
                    throw new TransactionError('Реферер не найден');
                }

                // Проверяем, что у пользователя ещё нет реферера
                const user = await client.query(
                    'SELECT referrer_id FROM users WHERE user_id = $1',
                    [userId]
                );

                if (user.rows[0]?.referrer_id) {
                    throw new TransactionError('У пользователя уже есть реферер');
                }

                // Обновляем информацию о реферере
                await client.query(
                    'UPDATE users SET referrer_id = $1 WHERE user_id = $2 AND referrer_id IS NULL',
                    [referrerId, userId]
                );

                // Логируем реферальную связь
                await client.query(
                    `INSERT INTO referral_links (referrer_id, referral_id, created_at)
                     VALUES ($1, $2, CURRENT_TIMESTAMP)`,
                    [referrerId, userId]
                );
            });
        } catch (error) {
            logger.error('Ошибка при добавлении реферала:', error);
            throw error;
        }
    }

    // Статистика рефералов
    async getReferralStats(userId: number): Promise<{ count: number; earnings: number }> {
        try {
            const result = await this.pool.query(
                `SELECT 
                    COUNT(DISTINCT u.user_id) as count,
                    COALESCE(SUM(rt.amount), 0) as earnings
                 FROM users u
                 LEFT JOIN referral_transactions rt ON rt.referrer_id = $1
                 WHERE u.referrer_id = $1`,
                [userId]
            );
            return {
                count: parseInt(result.rows[0].count),
                earnings: parseFloat(result.rows[0].earnings) || 0
            };
        } catch (error) {
            logger.error('Ошибка при получении статистики рефералов:', error);
            throw error;
        }
    }

    // Обработка реферальных платежей
    async processReferralPayment(paymentId: number): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                const payment = await client.query(
                    `SELECT p.user_id, p.amount, u.referrer_id 
                     FROM payments p
                     JOIN users u ON u.user_id = p.user_id
                     WHERE p.id = $1 AND p.status = 'paid'
                     FOR UPDATE`,
                    [paymentId]
                );

                if (payment.rows.length > 0 && payment.rows[0].referrer_id) {
                    const referralAmount = payment.rows[0].amount * 0.5;
                    
                    // Обновляем баланс реферера
                    await client.query(
                        'UPDATE users SET referral_earnings = referral_earnings + $1 WHERE user_id = $2',
                        [referralAmount, payment.rows[0].referrer_id]
                    );

                    // Создаем запись о реферальной транзакции
                    await client.query(
                        `INSERT INTO referral_transactions 
                         (referrer_id, referral_id, amount, payment_id, status, processed_at)
                         VALUES ($1, $2, $3, $4, 'completed', CURRENT_TIMESTAMP)`,
                        [payment.rows[0].referrer_id, payment.rows[0].user_id, referralAmount, paymentId]
                    );

                    logger.info('Реферальный платёж обработан:', {
                        paymentId,
                        referrerId: payment.rows[0].referrer_id,
                        amount: referralAmount
                    });
                }
            });
        } catch (error) {
            logger.error('Ошибка при обработке реферального платежа:', error);
            throw error;
        }
    }

    // Служебные методы
    async close(): Promise<void> {
        try {
            await this.pool.end();
            logger.info('База данных успешно закрыта');
        } catch (error) {
            logger.error('Ошибка при закрытии базы данных:', error);
            throw error;
        }
    }

    // Метод для проверки здоровья БД
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