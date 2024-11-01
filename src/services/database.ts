import { Pool } from 'pg';
import { ENV } from '../config/environment';
import { User, Payment, SpecialOffer, PhotoStats } from '../types/interfaces';

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

            // Основная таблица пользователей с новыми полями
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
                    processing_time INTEGER,
                    credits_used INTEGER DEFAULT 1
                );
            `);

            // Таблица специальных предложений
            await client.query(`
                CREATE TABLE IF NOT EXISTS special_offers (
                    id SERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    discount_percent INTEGER,
                    start_date TIMESTAMPTZ NOT NULL,
                    end_date TIMESTAMPTZ NOT NULL,
                    is_active BOOLEAN DEFAULT true,
                    min_credits INTEGER,
                    extra_credits INTEGER,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Таблица для отслеживания уведомлений
            await client.query(`
                CREATE TABLE IF NOT EXISTS notifications (
                    id SERIAL PRIMARY KEY,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    scheduled_for TIMESTAMPTZ,
                    sent_at TIMESTAMPTZ,
                    special_offer_id INTEGER REFERENCES special_offers(id),
                    is_sent BOOLEAN DEFAULT false
                );
            `);

            // Таблица рассылок
            await client.query(`
                CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
                    id TEXT PRIMARY KEY,
                    message TEXT NOT NULL,
                    image_path TEXT,
                    scheduled_time TIMESTAMPTZ NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Таблица для бэкапов
            await client.query(`
                CREATE TABLE IF NOT EXISTS backup_history (
                    id SERIAL PRIMARY KEY,
                    filename TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                    size_bytes BIGINT,
                    status TEXT,
                    error_message TEXT,
                    storage_path TEXT
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

    // Методы для работы с платежами
    async createPayment(userId: number, merchantOrderId: string, amount: number, credits: number, currency: string): Promise<void> {
        await this.pool.query(
            'INSERT INTO payments (user_id, merchant_order_id, amount, credits, status, currency) VALUES ($1, $2, $3, $4, \'pending\', $5)',
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
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                'UPDATE payments SET status = $1, order_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
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

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // Методы для работы со статистикой фото
    async updatePhotoProcessingStats(
        userId: number,
        success: boolean,
        errorMessage?: string,
        processingTime?: number
    ): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                'UPDATE users SET photos_processed = photos_processed + 1 WHERE user_id = $1',
                [userId]
            );

            await client.query(
                `INSERT INTO photo_processing_history 
                (user_id, success, error_message, processing_time) 
                VALUES ($1, $2, $3, $4)`,
                [userId, success, errorMessage, processingTime]
            );

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async getUserPhotoStats(userId: number): Promise<PhotoStats> {
        const result = await this.pool.query(`
            SELECT 
                u.photos_processed,
                COUNT(CASE WHEN ph.success = true THEN 1 END) as successful_photos,
                COUNT(CASE WHEN ph.success = false THEN 1 END) as failed_photos,
                COALESCE(AVG(ph.processing_time), 0) as avg_processing_time
            FROM users u
            LEFT JOIN photo_processing_history ph ON ph.user_id = u.user_id
            WHERE u.user_id = $1
            GROUP BY u.user_id, u.photos_processed
        `, [userId]);
        
        return result.rows[0] || {
            photos_processed: 0,
            successful_photos: 0,
            failed_photos: 0,
            avg_processing_time: 0
        };
    }

    // Методы для работы со специальными предложениями
    async createSpecialOffer(offer: SpecialOffer): Promise<number> {
        const result = await this.pool.query(
            `INSERT INTO special_offers 
            (title, description, discount_percent, start_date, end_date, min_credits, extra_credits) 
            VALUES ($1, $2, $3, $4, $5, $6, $7) 
            RETURNING id`,
            [
                offer.title,
                offer.description,
                offer.discountPercent,
                offer.startDate,
                offer.endDate,
                offer.minCredits,
                offer.extraCredits
            ]
        );
        return result.rows[0].id;
    }

    async getActiveSpecialOffers(): Promise<SpecialOffer[]> {
        const result = await this.pool.query(`
            SELECT * FROM special_offers 
            WHERE is_active = true 
            AND start_date <= NOW() 
            AND end_date >= NOW()
            ORDER BY created_at DESC
        `);
        return result.rows;
    }

    async deactivateSpecialOffer(offerId: number): Promise<void> {
        await this.pool.query(
            'UPDATE special_offers SET is_active = false WHERE id = $1',
            [offerId]
        );
    }

    // Методы для работы с уведомлениями
    async createNotification(notification: {
        type: string;
        title: string;
        message: string;
        scheduledFor?: Date;
        specialOfferId?: number;
    }): Promise<number> {
        const result = await this.pool.query(
            `INSERT INTO notifications 
            (type, title, message, scheduled_for, special_offer_id) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id`,
            [
                notification.type,
                notification.title,
                notification.message,
                notification.scheduledFor,
                notification.specialOfferId
            ]
        );
        return result.rows[0].id;
    }

    async getPendingNotifications(): Promise<any[]> {
        const result = await this.pool.query(`
            SELECT * FROM notifications 
            WHERE is_sent = false 
            AND (scheduled_for IS NULL OR scheduled_for <= NOW())
            ORDER BY created_at ASC
        `);
        return result.rows;
    }

    async markNotificationSent(notificationId: number): Promise<void> {
        await this.pool.query(
            'UPDATE notifications SET is_sent = true, sent_at = NOW() WHERE id = $1',
            [notificationId]
        );
    }

    async updateUserLastNotificationRead(userId: number): Promise<void> {
        await this.pool.query(
            'UPDATE users SET last_notification_read = NOW() WHERE user_id = $1',
            [userId]
        );
    }

    // Методы для работы с бэкапами
    async recordBackup(backup: {
        filename: string;
        sizeBytes: number;
        storagePath: string;
        status: string;
        errorMessage?: string;
    }): Promise<void> {
        await this.pool.query(
            `INSERT INTO backup_history 
            (filename, size_bytes, storage_path, status, error_message) 
            VALUES ($1, $2, $3, $4, $5)`,
            [
                backup.filename,
                backup.sizeBytes,
                backup.storagePath,
                backup.status,
                backup.errorMessage
            ]
        );
    }

    async getBackupHistory(limit: number = 10): Promise<any[]> {
        const result = await this.pool.query(
            'SELECT * FROM backup_history ORDER BY created_at DESC LIMIT $1',
            [limit]
        );
        return result.rows;
    }

    // Расширенные методы статистики
    async getDetailedStats(): Promise<any> {
        const [userStats, photoStats, paymentStats, offerStats] = await Promise.all([
            this.pool.query(`
                SELECT 
                    COUNT(*) as total_users,
                    COUNT(CASE WHEN last_used >= NOW() - INTERVAL '24 hours' THEN 1 END) as active_today,
                    SUM(credits) as total_credits,
                    SUM(photos_processed) as total_photos,
                    SUM(total_spent) as total_revenue
                FROM users
                WHERE accepted_rules = true
            `),
            this.pool.query(`
                SELECT 
                    COUNT(*) as total_processed,
                    COUNT(CASE WHEN success = true THEN 1 END) as successful,
                    COUNT(CASE WHEN success = false THEN 1 END) as failed,
                    AVG(processing_time) as avg_processing_time
                FROM photo_processing_history
                WHERE processed_at >= NOW() - INTERVAL '24 hours'
            `),
            this.pool.query(`
                SELECT 
                    COUNT(*) as total_payments,
                    SUM(amount) as total_amount,
                    COUNT(DISTINCT user_id) as unique_users
                FROM payments
                WHERE status = 'paid'
                AND created_at >= NOW() - INTERVAL '24 hours'
            `),
            this.pool.query(`
                SELECT 
                    COUNT(*) as active_offers,
                    AVG(discount_percent) as avg_discount
                FROM special_offers
                WHERE is_active = true
                AND start_date <= NOW()
                AND end_date >= NOW()
            `)
        ]);

        return {
            users: userStats.rows[0],
            photos: photoStats.rows[0],
            payments: paymentStats.rows[0],
            offers: offerStats.rows[0]
        };
    }

    async getUserFullStats(userId: number): Promise<any> {
        const result = await this.pool.query(`
            SELECT 
                u.photos_processed,
                u.total_spent,
                u.credits,
                COUNT(DISTINCT ph.id) FILTER (WHERE ph.success = true) as successful_photos,
                COUNT(DISTINCT ph.id) FILTER (WHERE ph.success = false) as failed_photos,
                AVG(ph.processing_time) as avg_processing_time,
                COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'paid') as total_payments,
                SUM(p.amount) FILTER (WHERE p.status = 'paid') as total_payments_amount,
                COUNT(DISTINCT ref.user_id) as referrals_count,
                COALESCE(SUM(u2.total_spent), 0) as referrals_spent
            FROM users u
            LEFT JOIN photo_processing_history ph ON ph.user_id = u.user_id
            LEFT JOIN payments p ON p.user_id = u.user_id
            LEFT JOIN users ref ON ref.referrer_id = u.user_id
            LEFT JOIN users u2 ON u2.referrer_id = u.user_id
            WHERE u.user_id = $1
            GROUP BY u.user_id, u.photos_processed, u.total_spent, u.credits
        `, [userId]);
        return result.rows[0];
    }

    // Методы для рассылок
    async getScheduledBroadcasts() {
        const result = await this.pool.query(`
            SELECT * FROM scheduled_broadcasts 
            WHERE scheduled_time > NOW()
            ORDER BY scheduled_time ASC
        `);
        return result.rows;
    }

    // Служебные методы
    async close(): Promise<void> {
        await this.pool.end();
    }
}

export const db = new DatabaseService();