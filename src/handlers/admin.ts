import { Context } from 'telegraf';
import { isAdmin } from '../middlewares/auth';
import { db } from '../services/database';
import { sendMessage } from '../utils/messages';
import { getAdminKeyboard } from '../utils/keyboard';

export async function handleAdminCommand(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) {
        return;
    }

    await sendMessage(
        ctx,
        '👨‍💼 Панель администратора\n\n' +
        'Выберите действие:',
        getAdminKeyboard()
    );
}

export async function handleStats(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        const stats = await db.getAdminStats();
        await sendMessage(
            ctx,
            formatStats(stats),
            getAdminKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при получении статистики:', error);
        await ctx.reply('❌ Произошла ошибка при получении статистики');
    }
}

function formatStats(stats: any): string {
    return '📊 <b>Статистика бота:</b>\n\n' +
        '👥 Пользователи:\n' +
        `• Всего: ${stats.users.total}\n` +
        `• Активных за 24ч: ${stats.users.active_24h}\n` +
        `• Оплативших: ${stats.users.paid}\n\n` +
        '📸 Обработка фото:\n' +
        `• Всего обработано: ${stats.photos.total_processed}\n` +
        `• Успешных: ${stats.photos.successful}\n` +
        `• Ошибок: ${stats.photos.failed}\n\n` +
        '💰 Платежи:\n' +
        `• Общая сумма: ${stats.payments.total_amount}₽`;
}