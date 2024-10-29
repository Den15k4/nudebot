import { Telegraf } from 'telegraf';
import { Pool } from 'pg';
import { RukassaPayment } from './rukassa';

interface BotConfig {
    bot_id: string;
    token: string;
    partner_id?: string;
    webhook_url?: string;
    settings?: Record<string, any>;
}

export class MultiBotManager {
    private bots: Map<string, Telegraf> = new Map();
    private payments: Map<string, RukassaPayment> = new Map();
    private pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    async initializeBot(config: BotConfig): Promise<void> {
        try {
            const bot = new Telegraf(config.token);
            
            // Создание экземпляра платежной системы для бота
            const payment = new RukassaPayment(this.pool, bot, config.bot_id);
            
            // Сохранение экземпляров
            this.bots.set(config.bot_id, bot);
            this.payments.set(config.bot_id, payment);

            // Запуск бота
            if (config.webhook_url) {
                await bot.telegram.setWebhook(config.webhook_url);
            }
            await bot.launch();

            console.log(`Bot ${config.bot_id} initialized successfully`);
        } catch (error) {
            console.error(`Failed to initialize bot ${config.bot_id}:`, error);
            throw error;
        }
    }

    async loadAllBots(): Promise<void> {
        try {
            const result = await this.pool.query(
                'SELECT * FROM bots WHERE status = $1',
                ['active']
            );

            for (const botConfig of result.rows) {
                await this.initializeBot(botConfig);
            }

            console.log(`Loaded ${result.rows.length} bots successfully`);
        } catch (error) {
            console.error('Failed to load bots:', error);
            throw error;
        }
    }

    getBot(botId: string): Telegraf | undefined {
        return this.bots.get(botId);
    }

    getPayment(botId: string): RukassaPayment | undefined {
        return this.payments.get(botId);
    }

    async stopBot(botId: string): Promise<void> {
        const bot = this.bots.get(botId);
        if (bot) {
            await bot.stop();
            this.bots.delete(botId);
            this.payments.delete(botId);
            console.log(`Bot ${botId} stopped successfully`);
        }
    }

    async stopAllBots(): Promise<void> {
        for (const [botId] of this.bots) {
            await this.stopBot(botId);
        }
    }

    getBotsCount(): number {
        return this.bots.size;
    }
}