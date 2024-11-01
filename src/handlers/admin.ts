import { Context } from 'telegraf';
import { isAdmin } from '../middlewares/auth';
import { broadcastService } from '../services/broadcast';
import { backupService } from '../services/backup';
import { db } from '../services/database';
import { sendMessageWithImage } from '../utils/messages';
import { PATHS } from '../config/environment';
import { 
    getAdminKeyboard, 
    getAdminStatsKeyboard, 
    getSpecialOffersKeyboard,
    getAdminBackupsKeyboard,
    getAdminBroadcastKeyboard
} from '../utils/keyboard';
import { DetailedStats, SpecialOffer } from '../types/interfaces';

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

export async function handleStats(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        const stats = await db.getDetailedStats();
        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.BALANCE,
            formatDetailedStats(stats),
            getAdminStatsKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при получении статистики:', error);
        await ctx.reply('❌ Произошла ошибка при получении статистики');
    }
}

export async function handleSpecialOffers(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        const activeOffers = await db.getActiveSpecialOffers();
        let message = '🎉 <b>Управление акциями</b>\n\n';

        if (activeOffers.length > 0) {
            message += 'Активные акции:\n\n';
            activeOffers.forEach((offer: SpecialOffer, index: number) => {
                message += `${index + 1}. ${offer.title}\n` +
                    `Скидка: ${offer.discountPercent}%\n` +
                    `До: ${new Date(offer.endDate).toLocaleDateString()}\n\n`;
            });
        } else {
            message += 'Нет активных акций\n';
        }

        await ctx.reply(message, getSpecialOffersKeyboard());
    } catch (error) {
        console.error('Ошибка при получении списка акций:', error);
        await ctx.reply('❌ Произошла ошибка при получении списка акций');
    }
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

export async function handleBroadcastCommand(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    await ctx.reply(
        '📢 Выберите тип рассылки:',
        getAdminBroadcastKeyboard()
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

export async function handleBackups(ctx: Context): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
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

        await ctx.reply(message, getAdminBackupsKeyboard());
    } catch (error) {
        console.error('Ошибка при получении списка бэкапов:', error);
        await ctx.reply('❌ Произошла ошибка при получении списка бэкапов');
    }
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

function formatDetailedStats(stats: DetailedStats): string {
    return '📊 <b>Подробная статистика:</b>\n\n' +
        '👥 Пользователи:\n' +
        `• Всего: ${stats.users.total_users}\n` +
        `• Активных за 24ч: ${stats.users.active_today}\n` +
        `• Всего кредитов: ${stats.users.total_credits}\n` +
        `• Общая выручка: ${stats.users.total_revenue}₽\n\n` +
        '📸 Обработка фото (за 24ч):\n' +
        `• Всего: ${stats.photos.total_processed}\n` +
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

export async function handleDeactivateOffer(ctx: Context, offerId: number): Promise<void> {
    if (!ctx.from || !await isAdmin(ctx.from.id.toString())) return;

    try {
        await db.deactivateSpecialOffer(offerId);
        await ctx.reply('✅ Акция успешно деактивирована');
        await handleSpecialOffers(ctx);
    } catch (error) {
        console.error('Ошибка при деактивации акции:', error);
        await ctx.reply('❌ Произошла ошибка при деактивации акции');
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
                        [{ text: '◀️ Вернуться в админ панель', callback_data: 'admin_back' }]
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
            id: `scheduled_${Date.now()}`,
            date,
            message: text,
            image: imagePath
        });

        await ctx.reply(
            `✅ Рассылка запланирована!\n\n` +
            `Дата: ${date.toLocaleString()}\n` +
            `ID рассылки: ${broadcastId}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '◀️ Вернуться в админ панель', callback_data: 'admin_back' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при планировании рассылки:', error);
        await ctx.reply('❌ Произошла ошибка при планировании рассылки');
    }
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function parseDate(dateStr: string): Date {
    const [day, month, year] = dateStr.split('.');
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}