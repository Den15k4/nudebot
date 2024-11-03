import { Context } from 'telegraf';
import { db } from '../services/database';
import { sendMessage } from '../utils/messages';
import { MESSAGES } from '../utils/messages';
import { getAdminKeyboard } from '../utils/keyboard';
import { logger } from '../utils/logger';
import { formatStats, formatDate, formatNumber } from '../utils/formatters';
import { ENV } from '../config/environment';
import { AdminAction, UserRole, WithdrawalStatus } from '../types/enums';

// Проверка прав администратора
async function isAdmin(userId: number): Promise<boolean> {
    return ENV.ADMIN_IDS.includes(userId.toString());
}

// Основной обработчик админ-панели
export async function handleAdminCommand(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;
        
        if (!await isAdmin(ctx.from.id)) {
            await ctx.reply('⚠️ Недостаточно прав для выполнения действия');
            return;
        }

        await sendMessage(
            ctx,
            '👨‍💼 Панель администратора\n\n' +
            'Выберите действие:',
            getAdminKeyboard()
        );

    } catch (error) {
        logger.error('Ошибка в админ-панели:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}

// Обработчик статистики
export async function handleStats(ctx: Context): Promise<void> {
    try {
        if (!ctx.from || !await isAdmin(ctx.from.id)) return;

        const stats = await db.getAdminStats();
        const now = new Date();
        const statsMessage = 
            '📊 <b>Статистика бота</b>\n\n' +
            `📅 Дата: ${formatDate.full(now)}\n\n` +
            '👥 Пользователи:\n' +
            `• Всего: ${formatNumber.default(stats.users.total)}\n` +
            `• Активных за 24ч: ${formatNumber.default(stats.users.active_24h)}\n` +
            `• Платящих: ${formatNumber.default(stats.users.paid)}\n\n` +
            '📸 Обработка фото:\n' +
            `• Всего обработано: ${formatNumber.default(stats.photos.total_processed)}\n` +
            `• Успешных: ${formatNumber.default(stats.photos.successful)}\n` +
            `• Ошибок: ${formatNumber.default(stats.photos.failed)}\n\n` +
            '💰 Финансы:\n' +
            `• Общая выручка: ${formatNumber.currency(stats.payments.total_amount, 'RUB')}\n` +
            `• Средний чек: ${formatNumber.currency(stats.payments.average_amount || 0, 'RUB')}`;

        await sendMessage(ctx, statsMessage, getAdminKeyboard());
        
    } catch (error) {
        logger.error('Ошибка при получении статистики:', error);
        await ctx.reply('Произошла ошибка при получении статистики');
    }
}

// Обработчик рассылок
export async function handleBroadcast(ctx: Context): Promise<void> {
    try {
        if (!ctx.from || !await isAdmin(ctx.from.id)) return;

        const args = ctx.message?.text?.split(' ');
        const broadcastMessage = args?.slice(1).join(' ');

        if (!broadcastMessage) {
            await sendMessage(
                ctx,
                '📨 Введите текст рассылки в формате:\n' +
                '/broadcast <текст сообщения>\n\n' +
                'Поддерживается HTML-разметка',
                getAdminKeyboard()
            );
            return;
        }

        // Получаем всех активных пользователей
        const users = await db.getAllUsers();
        let sent = 0;
        let failed = 0;

        const total = users.length;
        const startTime = Date.now();

        // Отправляем сообщение каждому пользователю
        for (const [index, user] of users.entries()) {
            try {
                await ctx.telegram.sendMessage(
                    user.user_id,
                    broadcastMessage,
                    { parse_mode: 'HTML' }
                );
                sent++;

                // Обновляем статус каждые 100 сообщений
                if (index % 100 === 0) {
                    const progress = ((index + 1) / total * 100).toFixed(1);
                    await ctx.reply(
                        `📤 Прогресс рассылки: ${progress}%\n` +
                        `✅ Отправлено: ${sent}\n` +
                        `❌ Ошибок: ${failed}`
                    );
                }

                // Задержка между сообщениями для избежания флуда
                await new Promise(resolve => setTimeout(resolve, 50));

            } catch (error) {
                failed++;
                logger.error('Ошибка при отправке рассылки:', {
                    userId: user.user_id,
                    error
                });
            }
        }

        const duration = formatDate.relative(new Date(startTime));
        await sendMessage(
            ctx,
            `✅ Рассылка завершена\n\n` +
            `📊 Статистика:\n` +
            `• Всего пользователей: ${total}\n` +
            `• Успешно отправлено: ${sent}\n` +
            `• Ошибок: ${failed}\n` +
            `• Время выполнения: ${duration}`,
            getAdminKeyboard()
        );

    } catch (error) {
        logger.error('Ошибка при выполнении рассылки:', error);
        await ctx.reply('Произошла ошибка при выполнении рассылки');
    }
}

// Обработчик заявок на вывод
export async function handleWithdrawals(ctx: Context): Promise<void> {
    try {
        if (!ctx.from || !await isAdmin(ctx.from.id)) return;

        const pendingWithdrawals = await db.getPendingWithdrawals();
        
        if (pendingWithdrawals.length === 0) {
            await sendMessage(
                ctx,
                '📝 Нет заявок на вывод средств',
                getAdminKeyboard()
            );
            return;
        }

        let message = '📝 Заявки на вывод средств:\n\n';
        
        for (const withdrawal of pendingWithdrawals) {
            const user = await db.getUserById(withdrawal.user_id);
            message += `🆔 ID: ${withdrawal.id}\n` +
                      `👤 Пользователь: ${user?.username || withdrawal.user_id}\n` +
                      `💰 Сумма: ${formatNumber.currency(withdrawal.amount, 'RUB')}\n` +
                      `💳 Реквизиты: ${withdrawal.payment_details.details}\n` +
                      `📅 Дата: ${formatDate.full(withdrawal.created_at)}\n\n`;
        }

        await sendMessage(
            ctx,
            message,
            {
                reply_markup: {
                    inline_keyboard: pendingWithdrawals.map(w => ([
                        {
                            text: `✅ Подтвердить #${w.id}`,
                            callback_data: `admin_approve_withdrawal_${w.id}`
                        },
                        {
                            text: `❌ Отклонить #${w.id}`,
                            callback_data: `admin_reject_withdrawal_${w.id}`
                        }
                    ]))
                }
            }
        );

    } catch (error) {
        logger.error('Ошибка при просмотре заявок на вывод:', error);
        await ctx.reply('Произошла ошибка при просмотре заявок');
    }
}

// Обработчик блокировки пользователей
export async function handleBanUser(ctx: Context): Promise<void> {
    try {
        if (!ctx.from || !await isAdmin(ctx.from.id)) return;

        const args = ctx.message?.text?.split(' ');
        const userId = parseInt(args?.[1] || '');
        const reason = args?.slice(2).join(' ') || 'Нарушение правил';

        if (!userId) {
            await sendMessage(
                ctx,
                '⚠️ Укажите ID пользователя:\n' +
                '/ban <user_id> [причина]',
                getAdminKeyboard()
            );
            return;
        }

        await db.updateUserRole(userId, UserRole.BANNED);
        await db.addBanRecord(userId, ctx.from.id, reason);

        // Уведомляем пользователя
        await ctx.telegram.sendMessage(
            userId,
            `🚫 Ваш аккаунт заблокирован\n\n` +
            `Причина: ${reason}\n\n` +
            `Для обжалования обратитесь в поддержку`
        ).catch(() => {});

        await sendMessage(
            ctx,
            `✅ Пользователь ${userId} заблокирован\n` +
            `Причина: ${reason}`,
            getAdminKeyboard()
        );

    } catch (error) {
        logger.error('Ошибка при блокировке пользователя:', error);
        await ctx.reply('Произошла ошибка при блокировке пользователя');
    }
}

// Обработчик просмотра логов
export async function handleViewLogs(ctx: Context): Promise<void> {
    try {
        if (!ctx.from || !await isAdmin(ctx.from.id)) return;

        const args = ctx.message?.text?.split(' ');
        const count = parseInt(args?.[1] || '50');
        const type = args?.[2] || 'error';

        const logs = await db.getLatestLogs(count, type);
        
        let message = `📋 Последние ${count} логов (тип: ${type}):\n\n`;
        
        for (const log of logs) {
            message += `⏰ ${formatDate.full(log.timestamp)}\n` +
                      `📝 ${log.message}\n` +
                      `🔍 ${JSON.stringify(log.metadata)}\n\n`;
        }

        // Разбиваем на части, если сообщение слишком длинное
        const parts = message.match(/.{1,4000}/g) || [];
        
        for (const part of parts) {
            await sendMessage(ctx, part);
        }

    } catch (error) {
        logger.error('Ошибка при просмотре логов:', error);
        await ctx.reply('Произошла ошибка при просмотре логов');
    }
}

// Экспорт всех обработчиков
export const adminHandlers = {
    handleAdminCommand,
    handleStats,
    handleBroadcast,
    handleWithdrawals,
    handleBanUser,
    handleViewLogs
};