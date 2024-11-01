import { Context } from 'telegraf';
import { isAdmin } from '../middlewares/auth';
import { broadcastService } from '../services/broadcast';
import { backupService } from '../services/backup';
import { db } from '../services/database';
import { sendMessageWithImage } from '../utils/messages';
import { PATHS } from '../config/environment';
import { getAdminKeyboard, getAdminStatsKeyboard, getSpecialOffersKeyboard } from '../utils/keyboard';
import { SpecialOffer } from '../types/interfaces';

// Админ команды
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

// Статистика
export async function handleStats(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        const stats = await db.getDetailedStats();
        
        const message = formatDetailedStats(stats);
        
        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.BALANCE,
            message,
            getAdminStatsKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при получении статистики:', error);
        await ctx.reply('❌ Произошла ошибка при получении статистики');
    }
}

// Форматирование статистики
function formatDetailedStats(stats: any): string {
    return '📊 <b>Подробная статистика бота:</b>\n\n' +
        '👥 Пользователи:\n' +
        `• Всего: ${stats.users.total_users}\n` +
        `• Активных за 24ч: ${stats.users.active_today}\n` +
        `• Общий баланс кредитов: ${stats.users.total_credits}\n\n` +
        '📸 Обработка фото (за 24ч):\n' +
        `• Всего обработано: ${stats.photos.total_processed}\n` +
        `• Успешных: ${stats.photos.successful}\n` +
        `• Ошибок: ${stats.photos.failed}\n` +
        `• Среднее время: ${Math.round(stats.photos.avg_processing_time || 0)}с\n\n` +
        '💰 Платежи (за 24ч):\n' +
        `• Количество: ${stats.payments.total_payments}\n` +
        `• Сумма: ${stats.payments.total_amount || 0}₽\n` +
        `• Уникальных пользователей: ${stats.payments.unique_users}\n\n` +
        '🎉 Акции:\n' +
        `• Активных акций: ${stats.offers.active_offers}\n` +
        `• Средняя скидка: ${Math.round(stats.offers.avg_discount || 0)}%`;
}

// Специальные предложения
export async function handleSpecialOffers(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    const activeOffers = await db.getActiveSpecialOffers();
    let message = '🎉 <b>Управление акциями</b>\n\n';

    if (activeOffers.length > 0) {
        message += 'Активные акции:\n\n';
        activeOffers.forEach((offer, index) => {
            message += `${index + 1}. ${offer.title}\n` +
                      `Скидка: ${offer.discount_percent}%\n` +
                      `До: ${new Date(offer.end_date).toLocaleDateString()}\n\n`;
        });
    } else {
        message += 'Нет активных акций\n';
    }

    await ctx.reply(message, getSpecialOffersKeyboard());
}

export async function handleCreateSpecialOffer(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;
    
    await ctx.reply(
        '🆕 Создание новой акции\n\n' +
        'Отправьте данные в формате:\n' +
        'Название\n' +
        'Описание\n' +
        'Процент скидки\n' +
        'Дата начала (DD.MM.YYYY)\n' +
        'Дата окончания (DD.MM.YYYY)\n' +
        'Минимум кредитов (опционально)\n' +
        'Бонусные кредиты (опционально)',
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Отмена', callback_data: 'admin_cancel' }]
                ]
            }
        }
    );
}

// Бэкапы
export async function handleBackups(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    const backups = await db.getBackupHistory(5);
    let message = '💾 <b>Управление бэкапами</b>\n\n';

    if (backups.length > 0) {
        message += 'Последние бэкапы:\n\n';
        backups.forEach((backup, index) => {
            message += `${index + 1}. ${backup.filename}\n` +
                      `Размер: ${formatBytes(backup.size_bytes)}\n` +
                      `Статус: ${backup.status}\n` +
                      `Создан: ${new Date(backup.created_at).toLocaleString()}\n\n`;
        });
    } else {
        message += 'Нет доступных бэкапов\n';
    }

    await ctx.reply(
        message,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📥 Создать бэкап', callback_data: 'admin_create_backup' }],
                    [{ text: '🔄 Восстановить из бэкапа', callback_data: 'admin_restore_backup' }],
                    [{ text: '◀️ Назад', callback_data: 'admin_back' }]
                ]
            }
        }
    );
}

export async function handleCreateBackup(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        const backupMessage = await ctx.reply('💾 Создание бэкапа...');
        await backupService.createBackup();
        await ctx.telegram.editMessageText(
            ctx.chat!.id,
            backupMessage.message_id,
            undefined,
            '✅ Бэкап успешно создан!'
        );
    } catch (error) {
        console.error('Ошибка при создании бэкапа:', error);
        await ctx.reply('❌ Произошла ошибка при создании бэкапа');
    }
}

// Рассылки
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

// Вспомогательные функции
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Обработка специальных предложений
export async function handleSpecialOfferCreation(ctx: Context, text: string): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        const lines = text.split('\n');
        if (lines.length < 5) {
            await ctx.reply('❌ Недостаточно данных. Пожалуйста, укажите все необходимые поля.');
            return;
        }

        const [title, description, discountStr, startDateStr, endDateStr, minCreditsStr, extraCreditsStr] = lines;

        const offer: SpecialOffer = {
            title,
            description,
            discountPercent: parseInt(discountStr),
            startDate: parseDate(startDateStr),
            endDate: parseDate(endDateStr),
            minCredits: minCreditsStr ? parseInt(minCreditsStr) : undefined,
            extraCredits: extraCreditsStr ? parseInt(extraCreditsStr) : undefined
        };

        const offerId = await db.createSpecialOffer(offer);
        
        await ctx.reply(
            '✅ Акция успешно создана!\n\n' +
            `Название: ${title}\n` +
            `Скидка: ${discountStr}%\n` +
            `Действует: ${startDateStr} - ${endDateStr}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '◀️ Назад к акциям', callback_data: 'admin_special_offers' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при создании акции:', error);
        await ctx.reply('❌ Произошла ошибка при создании акции. Проверьте формат данных.');
    }
}

function parseDate(dateStr: string): Date {
    const [day, month, year] = dateStr.split('.');
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}