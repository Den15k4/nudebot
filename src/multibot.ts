import { Telegraf } from 'telegraf';
import { Pool } from 'pg';
import { RukassaPayment } from './rukassa';
import { BotContext } from './types';

interface BotConfig {
    bot_id: string;
    token: string;
    partner_id?: string;
    webhook_url?: string;
    settings?: Record<string, any>;
}

export class MultiBotManager {
    private bots: Map<string, Telegraf<BotContext>> = new Map();
    private payments: Map<string, RukassaPayment> = new Map();
    private pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    async initializeBot(config: BotConfig): Promise<void> {
        try {
            const bot = new Telegraf<BotContext>(config.token);
            
            // Создаем экземпляр платежной системы для бота
            const payment = new RukassaPayment(this.pool, bot, config.bot_id);
            
            // Сохраняем экземпляры
            this.bots.set(config.bot_id, bot);
            this.payments.set(config.bot_id, payment);

            // Инициализируем платежную систему
            await payment.initPaymentsTable();

            // Настраиваем webhook если указан URL
            if (config.webhook_url) {
                await bot.telegram.setWebhook(config.webhook_url);
                console.log(`Webhook установлен для бота ${config.bot_id}: ${config.webhook_url}`);
            }

            // Запускаем бота
            await bot.launch();
            console.log(`Бот ${config.bot_id} успешно инициализирован`);

        } catch (error) {
            console.error(`Ошибка при инициализации бота ${config.bot_id}:`, error);
            
            // Очищаем созданные экземпляры в случае ошибки
            this.bots.delete(config.bot_id);
            this.payments.delete(config.bot_id);
            
            throw error;
        }
    }

    async loadAllBots(): Promise<void> {
        try {
            // Получаем все активные боты из базы данных
            const result = await this.pool.query(
                'SELECT * FROM bots WHERE status = $1',
                ['active']
            );

            console.log(`Найдено ${result.rows.length} активных ботов`);

            // Инициализируем каждого бота
            for (const botConfig of result.rows) {
                try {
                    await this.initializeBot(botConfig);
                } catch (error) {
                    console.error(`Ошибка при загрузке бота ${botConfig.bot_id}:`, error);
                    // Продолжаем загрузку остальных ботов
                    continue;
                }
            }

            console.log(`Загружено ${this.bots.size} ботов`);
        } catch (error) {
            console.error('Ошибка при загрузке ботов:', error);
            throw error;
        }
    }

    async addBot(config: BotConfig): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Добавляем бота в базу данных
            await client.query(
                `INSERT INTO bots (bot_id, token, partner_id, webhook_url, settings)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (bot_id) DO UPDATE
                 SET token = $2, partner_id = $3, webhook_url = $4, settings = $5`,
                [config.bot_id, config.token, config.partner_id, config.webhook_url, config.settings]
            );

            // Инициализируем бота
            await this.initializeBot(config);

            await client.query('COMMIT');
            console.log(`Бот ${config.bot_id} успешно добавлен`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`Ошибка при добавлении бота ${config.bot_id}:`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    async removeBot(botId: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Останавливаем бота
            await this.stopBot(botId);

            // Удаляем бота из базы данных
            await client.query(
                'UPDATE bots SET status = $1 WHERE bot_id = $2',
                ['inactive', botId]
            );

            await client.query('COMMIT');
            console.log(`Бот ${botId} успешно удален`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`Ошибка при удалении бота ${botId}:`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    async updateBotSettings(botId: string, settings: Record<string, any>): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Обновляем настройки в базе данных
            await client.query(
                'UPDATE bots SET settings = $1 WHERE bot_id = $2',
                [settings, botId]
            );

            // Перезапускаем бота с новыми настройками
            const bot = this.bots.get(botId);
            if (bot) {
                await this.stopBot(botId);
                const botConfig = (await client.query(
                    'SELECT * FROM bots WHERE bot_id = $1',
                    [botId]
                )).rows[0];
                await this.initializeBot(botConfig);
            }

            await client.query('COMMIT');
            console.log(`Настройки бота ${botId} успешно обновлены`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`Ошибка при обновлении настроек бота ${botId}:`, error);
            throw error;
        } finally {
            client.release();
        }
    }

    getBot(botId: string): Telegraf<BotContext> | undefined {
        return this.bots.get(botId);
    }
    getPayment(botId: string): RukassaPayment | undefined {
        return this.payments.get(botId);
    }

    getBotsCount(): number {
        return this.bots.size;
    }

    async stopBot(botId: string): Promise<void> {
        const bot = this.bots.get(botId);
        if (bot) {
            try {
                // Отключаем webhook
                await bot.telegram.deleteWebhook();
                // Останавливаем бота
                await bot.stop();
                // Удаляем экземпляры из памяти
                this.bots.delete(botId);
                this.payments.delete(botId);
                console.log(`Бот ${botId} успешно остановлен`);
            } catch (error) {
                console.error(`Ошибка при остановке бота ${botId}:`, error);
                throw error;
            }
        }
    }

    async stopAllBots(): Promise<void> {
        const errors: Error[] = [];
        
        // Останавливаем все боты
        for (const [botId] of this.bots) {
            try {
                await this.stopBot(botId);
            } catch (error) {
                errors.push(error as Error);
                console.error(`Ошибка при остановке бота ${botId}:`, error);
            }
        }

        // Очищаем все коллекции
        this.bots.clear();
        this.payments.clear();

        if (errors.length > 0) {
            throw new Error(`Произошли ошибки при остановке ботов: ${errors.map(e => e.message).join(', ')}`);
        }
    }

    // Получение статистики по ботам
    async getBotsStatistics(): Promise<Record<string, any>> {
        try {
            const stats = await this.pool.query(`
                SELECT 
                    b.bot_id,
                    b.partner_id,
                    COUNT(DISTINCT u.user_id) as users_count,
                    COUNT(p.id) as payments_count,
                    COALESCE(SUM(p.amount), 0) as total_amount
                FROM bots b
                LEFT JOIN users u ON b.bot_id = u.bot_id
                LEFT JOIN payments p ON b.bot_id = p.bot_id
                WHERE b.status = 'active'
                GROUP BY b.bot_id, b.partner_id
            `);

            return stats.rows;
        } catch (error) {
            console.error('Ошибка при получении статистики ботов:', error);
            throw error;
        }
    }
}