import { Context } from 'telegraf';
import { isAdmin } from '../middlewares/auth';
import { broadcastService } from '../services/broadcast';
import { db } from '../services/database';
import { getAdminKeyboard } from '../utils/keyboard';
import { sendMessageWithImage } from '../utils/messages';
import { PATHS } from '../config/environment';

export async function handleAdminCommand(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) {
        return;
    }

    await ctx.reply(
        '👨‍💼 Панель администратора\n\n' +
        'Выберите действие:',
        getAdminKeyboard()
    );
}

export async function handleBroadcastCommand(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    broadcastService.setAwaitingMessage(ctx.from.id);
    await ctx.reply(
        '📢 Выберите тип рассылки:\n\n' +
        '1. Отправьте текст для обычной рассылки\n' +
        '2. Отправьте изображение с текстом для рассылки с картинкой\n\n' +
        'Для отмены нажмите "Отменить рассылку"',
        {
            reply_markup: {
                keyboard: [
                    ['❌ Отменить рассылку'],
                    ['◀️ Назад']
                ],
                resize_keyboard: true
            }
        }
    );
}

export async function handleScheduleCommand(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    broadcastService.setAwaitingDate(ctx.from.id);
    await ctx.reply(
        '🕒 Отправьте дату и время рассылки в формате:\n' +
        'DD.MM.YYYY HH:mm\n\n' +
        'Например: 25.12.2024 15:30',
        {
            reply_markup: {
                keyboard: [
                    ['❌ Отменить рассылку'],
                    ['◀️ Назад']
                ],
                resize_keyboard: true
            }
        }
    );
}

export async function handleCancelBroadcast(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    broadcastService.clearAwaiting(ctx.from.id);
    await ctx.reply(
        '❌ Рассылка отменена',
        getAdminKeyboard()
    );
}

export async function handleStats(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        const stats = await db.getStats();
        
        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.BALANCE,
            '📊 <b>Статистика бота:</b>\n\n' +
            `👥 Всего пользователей: ${stats.totalUsers}\n` +
            `📅 Активных за 24 часа: ${stats.activeToday}\n\n` +
            `💳 Статистика кредитов:\n` +
            `• Всего: ${stats.creditsStats.total_credits || 0}\n` +
            `• Среднее на пользователя: ${Math.round(stats.creditsStats.avg_credits || 0)}\n` +
            `• Максимум у пользователя: ${stats.creditsStats.max_credits || 0}\n\n` +
            `📩 Запланированных рассылок: ${broadcastService.getScheduledBroadcastsCount()}`,
            getAdminKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при получении статистики:', error);
        await ctx.reply('❌ Произошла ошибка при получении статистики');
    }
}