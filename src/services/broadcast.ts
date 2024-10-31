import { Telegraf } from 'telegraf';
import { scheduleJob, Job } from 'node-schedule';
import { ScheduledBroadcast } from '../types/interfaces';
import { db } from './database';
import path from 'path';
import fs from 'fs/promises';
import { MessageOptions } from '../types/interfaces';

class BroadcastService {
    private scheduledBroadcasts = new Map<string, Job>();
    private awaitingBroadcastMessage = new Set<number>();
    private awaitingBroadcastDate = new Set<number>();
    private broadcastImage: { [key: string]: string } = {};

    constructor(private bot: Telegraf) {}

    isAwaitingMessage(userId: number): boolean {
        return this.awaitingBroadcastMessage.has(userId);
    }

    isAwaitingDate(userId: number): boolean {
        return this.awaitingBroadcastDate.has(userId);
    }

    setAwaitingMessage(userId: number): void {
        this.awaitingBroadcastMessage.add(userId);
    }

    setAwaitingDate(userId: number): void {
        this.awaitingBroadcastDate.add(userId);
    }

    clearAwaiting(userId: number): void {
        this.awaitingBroadcastMessage.delete(userId);
        this.awaitingBroadcastDate.delete(userId);
        delete this.broadcastImage[userId];
    }

    async saveTempImage(imageBuffer: Buffer, userId: number, keepFile: boolean = false): Promise<string> {
        const tempDir = path.join(__dirname, '../../temp');
        await fs.mkdir(tempDir, { recursive: true });
        
        const filename = keepFile ? 
            `broadcast_${Date.now()}.jpg` : 
            `temp_broadcast_${userId}.jpg`;
        const filePath = path.join(tempDir, filename);
        
        await fs.writeFile(filePath, imageBuffer);
        return filePath;
    }

    async deleteTempImage(imagePath: string): Promise<void> {
        try {
            await fs.unlink(imagePath);
        } catch (error) {
            console.error('Ошибка при удалении временного файла:', error);
        }
    }

    async sendMessageWithImage(
        userId: number,
        imagePath: string,
        text: string,
        options?: MessageOptions
    ): Promise<void> {
        try {
            const image = await fs.readFile(imagePath);
            await this.bot.telegram.sendPhoto(
                userId,
                { source: image },
                {
                    caption: text,
                    parse_mode: 'HTML',
                    ...(options || {})
                }
            );
        } catch (error) {
            console.error('Ошибка при отправке сообщения с изображением:', error);
            await this.bot.telegram.sendMessage(
                userId,
                text,
                {
                    parse_mode: 'HTML',
                    ...(options || {})
                }
            );
        }
    }

    async broadcast(
        message: string,
        image?: string,
        options?: MessageOptions
    ): Promise<{ success: number; failed: number }> {
        const users = await db.getAllUsers();
        let successCount = 0;
        let failedCount = 0;

        for (const user of users) {
            try {
                if (image) {
                    await this.sendMessageWithImage(user.user_id, image, message, options);
                } else {
                    await this.bot.telegram.sendMessage(
                        user.user_id,
                        message,
                        {
                            parse_mode: 'HTML',
                            ...(options || {})
                        }
                    );
                }
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (error) {
                console.error(`Ошибка отправки сообщения пользователю ${user.user_id}:`, error);
                failedCount++;
            }
        }

        return { success: successCount, failed: failedCount };
    }

    async scheduleBroadcast(broadcast: ScheduledBroadcast): Promise<string> {
        const job = scheduleJob(broadcast.date, async () => {
            try {
                await this.broadcast(broadcast.message, broadcast.image, broadcast.keyboard);
                this.scheduledBroadcasts.delete(broadcast.id);
                
                // Уведомляем админов
                for (const adminId of process.env.ADMIN_IDS?.split(',') || []) {
                    try {
                        await this.bot.telegram.sendMessage(
                            adminId,
                            `✅ Отложенная рассылка выполнена:\n${broadcast.message.substring(0, 100)}...`,
                            { parse_mode: 'HTML' }
                        );
                    } catch (error) {
                        console.error('Ошибка уведомления админа:', error);
                    }
                }

                // Удаляем временный файл изображения, если он есть
                if (broadcast.image) {
                    await this.deleteTempImage(broadcast.image);
                }
            } catch (error) {
                console.error('Ошибка выполнения отложенной рассылки:', error);
            }
        });

        this.scheduledBroadcasts.set(broadcast.id, job);
        return broadcast.id;
    }

    getScheduledBroadcastsCount(): number {
        return this.scheduledBroadcasts.size;
    }

    async restoreScheduledBroadcasts(): Promise<void> {
        const broadcasts = await db.getScheduledBroadcasts();
        for (const broadcast of broadcasts) {
            if (broadcast.date > new Date()) {
                await this.scheduleBroadcast(broadcast);
            }
        }
    }
}

export let broadcastService: BroadcastService;

export function initBroadcastService(bot: Telegraf): void {
    broadcastService = new BroadcastService(bot);
}