import { Context } from 'telegraf';
import { SupportedCurrency, ReferralTransaction } from '../types/interfaces';
import { paymentService } from '../services/payment';
import { sendMessageWithImage } from '../utils/messages';
import { PATHS } from '../config/environment';
import { 
    getMainKeyboard, 
    getInitialKeyboard, 
    getAdminKeyboard,
    getAdminStatsKeyboard,
    getSpecialOffersKeyboard,
    getAdminBackupsKeyboard,
    getAdminBroadcastKeyboard
} from '../utils/keyboard';
import { db } from '../services/database';
import { MESSAGES } from '../utils/messages';
import { isAdmin } from '../middlewares/auth';
import * as adminHandlers from './admin';
import { backupService } from '../services/backup';
import { StatsExporter } from '../services/stats';
import { ChartGenerator } from '../services/stats';
import { DetailedStats } from '../types/interfaces';

// Главная функция обработки callback'ов
export async function handleCallbacks(ctx: Context): Promise<void> {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
        return;
    }

    const action = ctx.callbackQuery.data;
    const userId = ctx.from?.id;

    if (!userId) return;

    try {
        await ctx.answerCbQuery();

        // Админ функции
        if (action.startsWith('admin_') && await isAdmin(userId.toString())) {
            await handleAdminCallbacks(ctx, action);
            return;
        }

        // Пользовательские действия
        switch (action) {
            case 'action_process_photo':
                const userCredits = await db.checkCredits(userId);
                if (userCredits <= 0) {
                    await sendMessageWithImage(
                        ctx,
                        PATHS.ASSETS.PAYMENT,
                        '❌ У вас недостаточно кредитов для обработки фото.\n' +
                        'Используйте команду /buy для покупки кредитов.',
                        getMainKeyboard()
                    );
                } else {
                    await sendMessageWithImage(
                        ctx,
                        PATHS.ASSETS.PAYMENT_PROCESS,
                        '📸 Отправьте фотографию для обработки.\n\n' +
                        '⚠️ Требования к фото:\n' +
                        '- Хорошее качество\n' +
                        '- Четкое изображение лица\n' +
                        '- Только совершеннолетние\n\n' +
                        `💳 У вас ${userCredits} кредитов`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '◀️ Назад в меню', callback_data: 'action_back' }]
                                ]
                            }
                        }
                    );
                }
                break;

            case 'action_buy':
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.PAYMENT,
                    '💳 Выберите способ оплаты:',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💳 Visa/MC (RUB)', callback_data: 'currency_RUB' }],
                                [{ text: '💳 Visa/MC (KZT)', callback_data: 'currency_KZT' }],
                                [{ text: '💳 Visa/MC (UZS)', callback_data: 'currency_UZS' }],
                                [{ text: '💎 Криптовалюта', callback_data: 'currency_CRYPTO' }],
                                [{ text: '◀️ Назад в меню', callback_data: 'action_back' }]
                            ]
                        }
                    }
                );
                break;
                case 'action_balance':
                const credits = await db.checkCredits(userId);
                const stats = await db.getUserPhotoStats(userId);
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.BALANCE,
                    `💳 Ваш баланс: ${credits} кредитов\n\n` +
                    `📊 Статистика:\n` +
                    `• Обработано фото: ${stats.photos_processed}\n` +
                    `• Успешно: ${stats.successful_photos}\n` +
                    `• Ошибок: ${stats.failed_photos}\n` +
                    `• Среднее время обработки: ${Math.round(stats.avg_processing_time || 0)}с`,
                    getMainKeyboard()
                );
                break;

            case 'action_referrals':
                const referralStats = await db.getReferralStats(userId);
                const transactions = await db.getRecentReferralTransactions(userId);
                
                let message = '👥 <b>Ваша реферальная программа:</b>\n\n' +
                    `🔢 Количество рефералов: ${referralStats.count}\n` +
                    `💰 Заработано: ${referralStats.earnings}₽\n\n` +
                    '🔗 Ваша реферальная ссылка:\n' +
                    `https://t.me/${ctx.botInfo?.username}?start=${userId}`;

                if (transactions.length > 0) {
                    message += '\n\n📝 Последние начисления:\n';
                    transactions.forEach((t: { 
                        username: string;
                        amount: number;
                        created_at: Date;
                        referrer_id: number;
                        referral_id: number;
                    }) => {
                        message += `${t.username}: ${t.amount}₽ (${new Date(t.created_at).toLocaleDateString()})\n`;
                    });
                }

                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.REFERRAL,
                    message,
                    getMainKeyboard()
                );
                break;

            case 'action_info':
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.WELCOME,
                    'ℹ️ <b>Информация о боте:</b>\n\n' +
                    '🤖 Этот бот использует нейросеть для обработки изображений.\n\n' +
                    '💡 Как использовать:\n' +
                    '1. Купите кредиты\n' +
                    '2. Отправьте фотографию\n' +
                    '3. Дождитесь результата\n\n' +
                    '⚠️ Требования к фото:\n' +
                    '- Хорошее качество\n' +
                    '- Четкое изображение лица\n' +
                    '- Только совершеннолетние',
                    getMainKeyboard()
                );
                break;

            case 'action_help':
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.WELCOME,
                    MESSAGES.HELP,
                    getMainKeyboard()
                );
                break;
                case 'action_back':
                const accepted = await db.hasAcceptedRules(userId);
                if (!accepted) {
                    await sendMessageWithImage(
                        ctx,
                        PATHS.ASSETS.WELCOME,
                        MESSAGES.WELCOME(false),
                        getInitialKeyboard()
                    );
                } else {
                    await sendMessageWithImage(
                        ctx,
                        PATHS.ASSETS.WELCOME,
                        MESSAGES.WELCOME(true),
                        getMainKeyboard()
                    );
                }
                break;

            case 'action_rules':
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.WELCOME,
                    MESSAGES.RULES,
                    getInitialKeyboard()
                );
                break;

            case 'action_accept_rules':
                await db.updateUserCredits(userId, 0);
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.WELCOME,
                    MESSAGES.RULES_ACCEPTED,
                    getMainKeyboard()
                );
                break;

            default:
                if (action.startsWith('currency_')) {
                    const currency = action.split('_')[1] as SupportedCurrency;
                    await handleCurrencySelection(ctx, userId, currency);
                } else if (action.startsWith('buy_')) {
                    const [_, packageId, currency] = action.split('_');
                    await handlePackageSelection(
                        ctx,
                        userId,
                        parseInt(packageId),
                        currency as SupportedCurrency
                    );
                } else {
                    console.log('Неизвестное действие:', action);
                }
        }
    } catch (error) {
        console.error('Ошибка при обработке callback:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}// Вспомогательные функции
async function handleCurrencySelection(ctx: Context, userId: number, currency: SupportedCurrency): Promise<boolean> {
    try {
        const packages = paymentService.getAvailablePackages(currency);
        if (packages.length === 0) return false;

        const activeOffers = await db.getActiveSpecialOffers();
        let offerMessage = '';
        
        if (activeOffers.length > 0) {
            offerMessage = '\n\n🎉 Активные акции:\n';
            activeOffers.forEach(offer => {
                offerMessage += `• ${offer.title}: -${offer.discountPercent}%\n`;
            });
        }

        const buttons = packages.map(pkg => {
            let price = pkg.prices[currency];
            let description = pkg.description;
            
            const applicableOffer = activeOffers.find(o => 
                (!o.minCredits || pkg.credits >= o.minCredits)
            );
            
            if (applicableOffer) {
                const discount = applicableOffer.discountPercent / 100;
                price = price * (1 - discount);
                description += ` (${applicableOffer.discountPercent}% OFF)`;
            }

            return [{
                text: `${description} - ${price} ${currency}`,
                callback_data: `buy_${pkg.id}_${currency}`
            }];
        });
        
        buttons.push([{
            text: '◀️ Назад',
            callback_data: 'action_back'
        }]);

        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.PAYMENT,
            `💳 Выберите пакет кредитов (цены в ${currency}):${offerMessage}`,
            { 
                reply_markup: {
                    inline_keyboard: buttons
                }
            }
        );
        return true;
    } catch (error) {
        console.error('Ошибка при выборе валюты:', error);
        return false;
    }
}

async function handlePackageSelection(ctx: Context, userId: number, packageId: number, currency: SupportedCurrency): Promise<void> {
    try {
        const paymentUrl = await paymentService.createPayment(userId, packageId, currency);
        const package_ = paymentService.getAvailablePackages(currency).find(p => p.id === packageId);

        const activeOffers = await db.getActiveSpecialOffers();
        const applicableOffer = activeOffers.find(o => 
            (!o.minCredits || package_!.credits >= o.minCredits)
        );

        let priceInfo = '';
        if (applicableOffer && package_) {
            const originalPrice = package_.prices[currency];
            const discountedPrice = originalPrice * (1 - applicableOffer.discountPercent / 100);
            priceInfo = `\nСтарая цена: ${originalPrice} ${currency}\n` +
                       `Скидка: ${applicableOffer.discountPercent}%\n` +
                       `Новая цена: ${discountedPrice} ${currency}`;
        }

        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.PAYMENT_PROCESS,
            `🔄 Для оплаты ${package_?.description} перейдите по кнопке ниже.${priceInfo}\n\n` +
            'После оплаты кредиты будут автоматически зачислены на ваш счет.' +
            (applicableOffer?.extraCredits ? `\n\n🎁 Бонус: +${applicableOffer.extraCredits} кредитов` : ''),
            {
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: '💳 Перейти к оплате',
                            url: paymentUrl
                        }],
                        [{
                            text: '◀️ Назад к выбору пакета',
                            callback_data: `currency_${currency}`
                        }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при создании платежа:', error);
        await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
    }
}

// Функции для админ-панели
// Обработчик админ-callback'ов
async function handleAdminCallbacks(ctx: Context, action: string): Promise<void> {
    try {
        switch (action) {
            case 'admin_stats':
                await adminHandlers.handleStats(ctx);
                break;

            case 'admin_detailed_stats':
                const stats = await db.getDetailedStats();
                await ctx.reply(
                    formatDetailedStats(stats),
                    getAdminStatsKeyboard()
                );
                break;

            case 'admin_stats_graphs':
                await handleStatsGraphs(ctx);
                break;

            case 'admin_export_stats':
                await ctx.reply(
                    '📊 Выберите формат экспорта:',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '📊 Excel', callback_data: 'admin_export_excel' },
                                    { text: '📝 CSV', callback_data: 'admin_export_csv' }
                                ],
                                [
                                    { text: '📋 JSON', callback_data: 'admin_export_json' },
                                    { text: '📄 PDF', callback_data: 'admin_export_pdf' }
                                ],
                                [{ text: '◀️ Назад', callback_data: 'admin_back' }]
                            ]
                        }
                    }
                );
                break;

            case 'admin_export_excel':
            case 'admin_export_csv':
            case 'admin_export_json':
            case 'admin_export_pdf':
                await handleStatsExport(ctx, action.split('_')[2]);
                break;

            case 'admin_special_offers':
                await adminHandlers.handleSpecialOffers(ctx);
                break;

            case 'admin_create_offer':
                await adminHandlers.handleCreateSpecialOffer(ctx);
                break;

            case 'admin_edit_offers':
                const activeOffers = await db.getActiveSpecialOffers();
                if (activeOffers.length === 0) {
                    await ctx.reply('❌ Нет активных акций для редактирования');
                    return;
                }

                const buttons = activeOffers.map(offer => ([{
                    text: offer.title,
                    callback_data: `admin_edit_offer_${offer.id}`
                }]));
                buttons.push([{ text: '◀️ Назад', callback_data: 'admin_special_offers' }]);

                await ctx.reply(
                    '📝 Выберите акцию для редактирования:',
                    { reply_markup: { inline_keyboard: buttons } }
                );
                break;

            case 'admin_backups':
                await adminHandlers.handleBackups(ctx);
                break;

            case 'admin_create_backup':
                await adminHandlers.handleCreateBackup(ctx);
                break;

            case 'admin_backup_schedule':
                await ctx.reply(
                    '⚙️ Настройка расписания бэкапов\n\n' +
                    'Текущее расписание: каждый день в 03:00\n\n' +
                    'Выберите новое расписание:',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Каждый день', callback_data: 'admin_backup_schedule_daily' }],
                                [{ text: 'Каждую неделю', callback_data: 'admin_backup_schedule_weekly' }],
                                [{ text: 'Каждый месяц', callback_data: 'admin_backup_schedule_monthly' }],
                                [{ text: '◀️ Назад', callback_data: 'admin_backups' }]
                            ]
                        }
                    }
                );
                break;

            case 'admin_broadcast':
                await ctx.reply(
                    '📢 Выберите тип рассылки:',
                    getAdminBroadcastKeyboard()
                );
                break;

            case 'admin_broadcast_all':
                await adminHandlers.handleBroadcastCommand(ctx);
                break;

            case 'admin_broadcast_select':
                await ctx.reply(
                    '🎯 Выберите группу пользователей:',
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '💳 С балансом > 0', callback_data: 'admin_broadcast_with_credits' },
                                    { text: '🆕 Новые пользователи', callback_data: 'admin_broadcast_new_users' }
                                ],
                                [
                                    { text: '💰 Совершившие платежи', callback_data: 'admin_broadcast_paid_users' },
                                    { text: '📸 Активные', callback_data: 'admin_broadcast_active_users' }
                                ],
                                [{ text: '◀️ Назад', callback_data: 'admin_broadcast' }]
                            ]
                        }
                    }
                );
                break;

            case 'admin_stats_refresh':
                await adminHandlers.handleStats(ctx);
                break;

            case 'admin_back':
                await ctx.reply(
                    '👨‍💼 Панель администратора',
                    getAdminKeyboard()
                );
                break;

            default:
                if (action.startsWith('admin_deactivate_offer_')) {
                    const offerId = parseInt(action.split('_')[3]);
                    await handleOfferDeactivation(ctx, offerId);
                } 
                else if (action.startsWith('admin_restore_backup_')) {
                    const backupId = parseInt(action.split('_')[3]);
                    await handleBackupRestore(ctx, backupId);
                }
                else if (action.startsWith('admin_edit_offer_')) {
                    const offerId = parseInt(action.split('_')[3]);
                    await handleOfferEdit(ctx, offerId);
                }
                else if (action.startsWith('admin_broadcast_')) {
                    const targetGroup = action.split('_')[2];
                    await handleTargetedBroadcast(ctx, targetGroup);
                }
                else if (action.startsWith('admin_graph_')) {
                    const chartType = action.split('_')[2];
                    await handleChartGeneration(ctx, chartType);
                }
        }
    } catch (error) {
        console.error('Ошибка при обработке админ-callback:', error);
        await ctx.reply('❌ Произошла ошибка при выполнении действия');
    }
}

async function handleStatsGraphs(ctx: Context): Promise<void> {
    try {
        const chartGenerator = new ChartGenerator();
        const charts = await chartGenerator.generateDashboard();
        await ctx.replyWithPhoto({ source: charts });
    } catch (error) {
        console.error('Ошибка при генерации графиков:', error);
        await ctx.reply('❌ Произошла ошибка при генерации графиков');
    }
}

async function handleStatsExport(ctx: Context, format: string): Promise<void> {
    try {
        const exporter = new StatsExporter();
        const file = await exporter.exportStats(format);
        const fileName = `stats_${new Date().toISOString()}.${format}`;
        await ctx.replyWithDocument({ source: file, filename: fileName });
    } catch (error) {
        console.error('Ошибка при экспорте статистики:', error);
        await ctx.reply('❌ Произошла ошибка при экспорте статистики');
    }
}

async function handleOfferDeactivation(ctx: Context, offerId: number): Promise<void> {
    try {
        await db.deactivateSpecialOffer(offerId);
        await ctx.reply('✅ Акция успешно деактивирована');
        await adminHandlers.handleSpecialOffers(ctx);
    } catch (error) {
        console.error('Ошибка при деактивации акции:', error);
        await ctx.reply('❌ Произошла ошибка при деактивации акции');
    }
}

async function handleOfferEdit(ctx: Context, offerId: number): Promise<void> {
    try {
        const offer = await db.getOfferById(offerId);
        if (!offer) {
            await ctx.reply('❌ Акция не найдена');
            return;
        }

        await ctx.reply(
            '📝 Редактирование акции\n\n' +
            'Текущие параметры:\n' +
            `Название: ${offer.title}\n` +
            `Описание: ${offer.description}\n` +
            `Скидка: ${offer.discountPercent}%\n` +
            `Действует до: ${new Date(offer.endDate).toLocaleDateString()}\n\n` +
            'Отправьте новые параметры в формате:\n' +
            'Название\n' +
            'Описание\n' +
            'Процент скидки\n' +
            'Дата окончания (DD.MM.YYYY)',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'admin_special_offers' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при редактировании акции:', error);
        await ctx.reply('❌ Произошла ошибка при редактировании акции');
    }
}

async function handleBackupRestore(ctx: Context, backupId: number): Promise<void> {
    try {
        const backups = await db.getBackupHistory();
        const backup = backups.find(b => b.id === backupId);
        if (backup) {
            await ctx.reply('🔄 Начинаю восстановление из бэкапа...');
            await backupService.restoreFromBackup(backup.filename);
            await ctx.reply('✅ Восстановление успешно завершено');
        }
    } catch (error) {
        console.error('Ошибка при восстановлении из бэкапа:', error);
        await ctx.reply('❌ Произошла ошибка при восстановлении');
    }
}
async function handleChartGeneration(ctx: Context, chartType: string): Promise<void> {
    try {
        const chartGenerator = new ChartGenerator();
        const chart = await chartGenerator.generateChart(chartType);
        await ctx.replyWithPhoto({ source: chart });
    } catch (error) {
        console.error('Ошибка при генерации графика:', error);
        await ctx.reply('❌ Произошла ошибка при генерации графика');
    }
}

async function handleTargetedBroadcast(ctx: Context, targetGroup: string): Promise<void> {
    try {
        let users: number[] = [];
        switch (targetGroup) {
            case 'with_credits':
                users = await db.getUsersWithCredits();
                break;
            case 'new_users':
                users = await db.getNewUsers(24); // последние 24 часа
                break;
            case 'paid_users':
                users = await db.getPaidUsers();
                break;
            case 'active_users':
                users = await db.getActiveUsers(7); // активные за последние 7 дней
                break;
        }

        if (users.length === 0) {
            await ctx.reply('❌ Нет пользователей в выбранной группе');
            return;
        }

        await ctx.reply(
            `✅ Выбрано ${users.length} пользователей\n` +
            'Отправьте сообщение для рассылки:',
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отмена', callback_data: 'admin_broadcast' }]
                    ]
                }
            }
        );
    } catch (error) {
        console.error('Ошибка при подготовке целевой рассылки:', error);
        await ctx.reply('❌ Произошла ошибка при подготовке рассылки');
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