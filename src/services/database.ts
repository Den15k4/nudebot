import { Pool, PoolClient } from 'pg';
import { ENV } from '../config/environment';
import { 
    User, 
    Payment, 
    PhotoStats, 
    AdminStats, 
    TransactionError,
    PhotoProcessingStats
} from '../types/interfaces';
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
            max: ENV.DB_MAX_CONNECTIONS,
            idleTimeoutMillis: ENV.DB_IDLE_TIMEOUT,
            connectionTimeoutMillis: 2000
        });

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
        return this.withTransaction(async (client) => {
            // Создание таблицы пользователей
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
                
                -- Индексы для пользователей
                CREATE INDEX IF NOT EXISTS idx_users_last_used ON users(last_used);
                CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
                CREATE INDEX IF NOT EXISTS idx_users_pending_task ON users(pending_task_id);
                CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
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
                    error_message TEXT
                );
                
                -- Индексы для платежей
                CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
                CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
                CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
            `);

            // Создание таблицы обработки фото
            await client.query(`
                CREATE TABLE IF NOT EXISTS photo_processing_history (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT REFERENCES users(user_id),
                    processed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN,
                    error_message TEXT,
                    processing_time INTEGER,
                    file_size BIGINT,
                    credits_used INTEGER DEFAULT 1,
                    task_id TEXT
                );
                
                -- Индексы для истории обработки
                CREATE INDEX IF NOT EXISTS idx_photo_user_id ON photo_processing_history(user_id);
                CREATE INDEX IF NOT EXISTS idx_photo_processed_at ON photo_processing_history(processed_at);
                CREATE INDEX IF NOT EXISTS idx_photo_success ON photo_processing_history(success);
            `);

            // Создание таблицы реферальных транзакций
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
                
                -- Индексы для реферальных транзакций
                CREATE INDEX IF NOT EXISTS idx_ref_trans_referrer ON referral_transactions(referrer_id);
                CREATE INDEX IF NOT EXISTS idx_ref_trans_referral ON referral_transactions(referral_id);
                CREATE INDEX IF NOT EXISTS idx_ref_trans_status ON referral_transactions(status);
            `);

            logger.info('Таблицы базы данных успешно инициализированы');
        });
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

    async updateUserRules(userId: number): Promise<void> {
        try {
            await this.pool.query(
                'UPDATE users SET accepted_rules = TRUE WHERE user_id = $1',
                [userId]
            );
            logger.info(`Пользователь ${userId} принял правила`);
        } catch (error) {
            logger.error('Ошибка при обновлении статуса правил:', error);
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

    // Методы работы с платежами
    async createPayment(
        userId: number,
        merchantOrderId: string,
        amount: number,
        credits: number,
        currency: string
    ): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                await client.query(
                    `INSERT INTO payments 
                     (user_id, merchant_order_id, amount, credits, status, currency) 
                     VALUES ($1, $2, $3, $4, 'pending', $5)`,
                    [userId, merchantOrderId, amount, credits, currency]
                );
                logger.info('Создан новый платёж:', { userId, merchantOrderId, amount, credits });
            });
        } catch (error) {
            logger.error('Ошибка при создании платежа:', error);
            throw error;
        }
    }

    async deletePayment(merchantOrderId: string): Promise<void> {
        try {
            await this.pool.query(
                'DELETE FROM payments WHERE merchant_order_id = $1',
                [merchantOrderId]
            );
            logger.info('Удалён платёж:', { merchantOrderId });
        } catch (error) {
            logger.error('Ошибка при удалении платежа:', error);
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
                        'SELECT user_id, amount FROM payments WHERE id = $1',
                        [id]
                    );
                    
                    if (payment.rows.length > 0) {
                        await client.query(
                            'UPDATE users SET total_spent = total_spent + $1 WHERE user_id = $2',
                            [payment.rows[0].amount, payment.rows[0].user_id]
                        );
                    }
                }

                logger.info('Обновлён статус платежа:', { id, status, orderId });
            });
        } catch (error) {
            logger.error('Ошибка при обновлении статуса платежа:', error);
            throw error;
        }
    }

    // Методы работы с обработкой фото
    async updatePhotoProcessingStats(
        userId: number,
        success: boolean,
        errorMessage?: string,
        processingTime?: number,
        fileSize?: number
    ): Promise<void> {
        try {
            await this.withTransaction(async (client) => {
                await client.query(
                    `UPDATE users 
                     SET photos_processed = photos_processed + 1,
                         last_used = CURRENT_TIMESTAMP 
                     WHERE user_id = $1`,
                    [userId]
                );

                await client.query(
                    `INSERT INTO photo_processing_history 
                     (user_id, success, error_message, processing_time, file_size) 
                     VALUES ($1, $2, $3, $4, $5)`,
                    [userId, success, errorMessage, processingTime, fileSize]
                );

                logger.info('Обновлена статистика обработки фото:', {
                    userId,
                    success,
                    processingTime
                });
            });
        } catch (error) {
            logger.error('Ошибка при обновлении статистики фото:', error);
            throw error;
        }
    }

    async getUserPhotoStats(userId: number): Promise<PhotoStats> {
        try {
            const result = await this.pool.query(`
                SELECT 
                    COUNT(*) as total_processed,
                    COUNT(CASE WHEN success = true THEN 1 END) as successful_photos,
                    COUNT(CASE WHEN success = false THEN 1 END) as failed_photos,
                    COALESCE(AVG(processing_time), 0) as avg_processing_time
                FROM photo_processing_history
                WHERE user_id = $1
            `, [userId]);
            
            return {
                total_processed: parseInt(result.rows[0].total_processed),
                successful_photos: parseInt(result.rows[0].successful_photos),
                failed_photos: parseInt(result.rows[0].failed_photos),
                avg_processing_time: parseFloat(result.rows[0].avg_processing_time)
            };
        } catch (error) {
            logger.error('Ошибка при получении статистики фото:', error);
            throw error;
        }
    }

    // Методы для админ-панели
    async getAdminStats(): Promise<AdminStats> {
        try {
            return this.withTransaction(async (client) => {
                // Статистика пользователей
                const usersStats = await client.query(`
                    SELECT 
                        COUNT(DISTINCT u.user_id) as total,
                        COUNT(DISTINCT CASE 
                            WHEN u.last_used >= NOW() - INTERVAL '24 hours' 
                            THEN u.user_id 
                        END) as active_24h,
                        COUNT(DISTINCT CASE 
                            WHEN EXISTS (
                                SELECT 1 FROM payments p 
                                WHERE p.user_id = u.user_id AND p.status = 'paid'
                            ) 
                            THEN u.user_id 
                        END) as paid_users
                    FROM users u
                `);

                // Статистика фото
                const photoStats = await client.query(`
                    SELECT 
                        COUNT(*) as total_processed,
                        COUNT(CASE WHEN success = true THEN 1 END) as successful,
                        COUNT(CASE WHEN success = false THEN 1 END) as failed
                    FROM photo_processing_history
                `);

                // Статистика платежей
                const paymentStats = await client.query(`
                    SELECT COALESCE(SUM(amount), 0) as total_amount
                    FROM payments 
                    WHERE status = 'paid'
                `);

                return {
                    users: {
                        total: parseInt(usersStats.rows[0].total),
                        active_24h: parseInt(usersStats.rows[0].active_24h),
                        paid: parseInt(usersStats.rows[0].paid_users)
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
            });
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

    // Метод для очистки старых задач
    async cleanupOldTasks(hours: number = 24): Promise<void> {
        try {
            const result = await this.pool.query(
                `UPDATE users 
                 SET pending_task_id = NULL 
                 WHERE pending_task_id IS NOT NULL 
                 AND last_used < NOW() - INTERVAL '${hours} hours'`
            );
            logger.info(`Очищено ${result.rowCount} старых задач`);
        } catch (error) {
            logger.error('Ошибка при очистке старых задач:', error);
            throw error;
        }
    }
}

export const db = new DatabaseService();