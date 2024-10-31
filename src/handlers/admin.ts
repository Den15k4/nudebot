import { Context } from 'telegraf';
import { isAdmin } from '../middlewares/auth';
import { broadcastService } from '../services/broadcast';
import { db } from '../services/database';
import { sendMessageWithImage } from '../utils/messages';
import { PATHS } from '../config/environment';

export async function handleAdminCommand(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) {
        return;
    }

    await ctx.reply(
        '👨‍💼 Панель администратора\n\n' +
        'Выберите действие:',
        {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📢 Рассылка', callback_data: 'admin_broadcast' },
                        { text: '🕒 Отложенная рассылка', callback_data: 'admin_schedule' }
                    ],
                    [
                        { text: '📊 Статистика', callback_data: 'admin_stats' },
                        { text: '❌ Отменить рассылку', callback_data: 'admin_cancel_broadcast' }
                    ],
                    [{ text: '◀️ Назад', callback_data: 'action_back' }]
                ]
            }
        }
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
                inline_keyboard: [
                    [{ text: '❌ Отменить рассылку', callback_data: 'admin_cancel_broadcast' }],
                    [{ text: '◀️ Назад', callback_data: 'action_back' }]
                ]
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
                inline_keyboard: [
                    [{ text: '❌ Отменить рассылку', callback_data: 'admin_cancel_broadcast' }],
                    [{ text: '◀️ Назад', callback_data: 'action_back' }]
                ]
            }
        }
    );
}

export async function handleCancelBroadcast(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    broadcastService.clearAwaiting(ctx.from.id);
    await ctx.reply(
        '❌ Рассылка отменена',
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '◀️ Вернуться в админ панель', callback_data: 'admin_back' }]
                ]
            }
        }
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
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔄 Обновить', callback_data: 'admin_stats_refresh' },
                            { text: '◀️ Назад', callback_data: 'action_back' }
                        ]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при получении статистики:', error);
        await ctx.reply('❌ Произошла ошибка при получении статистики');
    }
}

export async function handleBroadcastMessage(ctx: Context, text: string, imageBuffer?: Buffer): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        let imagePath: string | undefined;
        if (imageBuffer) {
            imagePath = await broadcastService.saveTempImage(imageBuffer, ctx.from.id);
        }

        const result = await broadcastService.broadcast(text, imagePath);
        
        if (imagePath) {
            await broadcastService.deleteTempImage(imagePath);
        }

        await ctx.reply(
            `✅ Рассылка завершена!\n\n` +
            `Успешно: ${result.success}\n` +
            `Ошибок: ${result.failed}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '◀️ Вернуться в админ панель', callback_data: 'action_back' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при выполнении рассылки:', error);
        await ctx.reply('❌ Произошла ошибка при выполнении рассылки');
    }
}

export async function handleScheduledBroadcast(
    ctx: Context,
    date: Date,
    text: string,
    imageBuffer?: Buffer
): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        let imagePath: string | undefined;
        if (imageBuffer) {
            imagePath = await broadcastService.saveTempImage(imageBuffer, ctx.from.id, true);
        }

        const broadcastId = await broadcastService.scheduleBroadcast({
            date,
            message: text,
            image: imagePath,
            id: `scheduled_${Date.now()}`
        });

        await ctx.reply(
            `✅ Рассылка запланирована!\n\n` +
            `Дата: ${date.toLocaleString()}\n` +
            `ID рассылки: ${broadcastId}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '◀️ Вернуться в админ панель', callback_data: 'action_back' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при планировании рассылки:', error);
        await ctx.reply('❌ Произошла ошибка при планировании рассылки');
    }
}