import { Context } from 'telegraf';
import { SupportedCurrency } from '../types/interfaces';
import { paymentService } from '../services/payment';
import { sendMessage } from '../utils/messages';
import { 
    getMainKeyboard, 
    getInitialKeyboard, 
    getAdminKeyboard,
    getPaymentKeyboard,
    getPhotoProcessingKeyboard,
    getReferralKeyboard,
    getBalanceKeyboard
} from '../utils/keyboard';
import { db } from '../services/database';
import { MESSAGES } from '../utils/messages';
import { isAdmin } from '../middlewares/auth';

// Обработка административных действий
async function handleAdminCallbacks(ctx: Context, action: string): Promise<void> {
    try {
        if (action === 'admin_stats') {
            const stats = await db.getAdminStats();
            await sendMessage(
                ctx,
                `📊 <b>Статистика:</b>\n\n` +
                `👥 Пользователи:\n` +
                `• Всего: ${stats.users.total}\n` +
                `• Активных за 24ч: ${stats.users.active_24h}\n` +
                `• Оплативших: ${stats.users.paid}\n\n` +
                `📸 Обработка фото:\n` +
                `• Всего: ${stats.photos.total_processed}\n` +
                `• Успешных: ${stats.photos.successful}\n` +
                `• Ошибок: ${stats.photos.failed}\n\n` +
                `💰 Платежи:\n` +
                `• Общая сумма: ${stats.payments.total_amount}₽`,
                getAdminKeyboard()
            );
        }
    } catch (error) {
        console.error('Ошибка при обработке админ-callback:', error);
        await sendMessage(ctx, '❌ Произошла ошибка при выполнении действия');
    }
}

// Обработка выбора валюты
async function handleCurrencySelection(ctx: Context, userId: number, currency: SupportedCurrency): Promise<boolean> {
    try {
        console.log('Обработка выбора валюты:', { userId, currency });
        
        const packages = paymentService.getAvailablePackages(currency);
        console.log('Доступные пакеты:', packages);
        
        if (packages.length === 0) {
            await sendMessage(ctx, '❌ Нет доступных пакетов для выбранной валюты');
            return false;
        }

        const buttons = packages.map(pkg => [{
            text: `${pkg.description} - ${pkg.prices[currency]} ${currency}`,
            callback_data: `buy_${pkg.id}_${currency}`
        }]);
        
        buttons.push([{
            text: '◀️ Назад',
            callback_data: 'action_back'
        }]);

        await sendMessage(
            ctx,
            `💳 Выберите пакет кредитов (цены в ${currency}):`,
            { 
                reply_markup: {
                    inline_keyboard: buttons
                }
            }
        );
        return true;
    } catch (error) {
        console.error('Ошибка при выборе валюты:', error);
        await sendMessage(ctx, '❌ Произошла ошибка при выборе валюты. Попробуйте позже.');
        return false;
    }
}

// Обработка выбора пакета
async function handlePackageSelection(ctx: Context, userId: number, packageId: number, currency: SupportedCurrency): Promise<void> {
    try {
        console.log('Обработка выбора пакета:', { userId, packageId, currency });
        
        const paymentUrl = await paymentService.createPayment(userId, packageId, currency);
        const package_ = paymentService.getAvailablePackages(currency).find(p => p.id === packageId);

        if (!package_) {
            throw new Error('Пакет не найден');
        }

        await sendMessage(
            ctx,
            `🔄 Для оплаты ${package_.description} (${package_.prices[currency]} ${currency}) перейдите по кнопке ниже.\n\n` +
            'После оплаты кредиты будут автоматически зачислены на ваш счет.',
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
        const errorMessage = error instanceof Error ? error.message : 'Произошла ошибка при создании платежа';
        await sendMessage(ctx, `❌ ${errorMessage}`);
    }
}

// Основная функция обработки callback-запросов
export async function handleCallbacks(ctx: Context): Promise<void> {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
        return;
    }

    const action = ctx.callbackQuery.data;
    const userId = ctx.from?.id;

    if (!userId) return;

    console.log('Получен callback:', { action, userId });

    try {
        await ctx.answerCbQuery().catch(console.error);

        // Обработка действий администратора
        if (action.startsWith('admin_') && await isAdmin(userId.toString())) {
            await handleAdminCallbacks(ctx, action);
            return;
        }

        // Обработка выбора валюты
        if (action.startsWith('currency_')) {
            const currency = action.split('_')[1] as SupportedCurrency;
            await handleCurrencySelection(ctx, userId, currency);
            return;
        }

        // Обработка выбора пакета
        if (action.startsWith('buy_')) {
            const [_, packageId, currency] = action.split('_');
            await handlePackageSelection(
                ctx,
                userId,
                parseInt(packageId),
                currency as SupportedCurrency
            );
            return;
        }

        // Обработка остальных действий
        switch (action) {
            case 'action_process_photo': {
                const userCredits = await db.checkCredits(userId);
                if (userCredits <= 0) {
                    await sendMessage(
                        ctx,
                        MESSAGES.ERRORS.INSUFFICIENT_CREDITS,
                        getMainKeyboard()
                    );
                } else {
                    await sendMessage(
                        ctx,
                        '📸 Отправьте фотографию для обработки.\n\n' +
                        '⚠️ Требования к фото:\n' +
                        '- Хорошее качество\n' +
                        '- Четкое изображение лица\n' +
                        '- Только совершеннолетние\n\n' +
                        `💳 У вас ${userCredits} кредитов`,
                        getPhotoProcessingKeyboard()
                    );
                }
                break;
            }

            case 'action_buy': {
                await sendMessage(
                    ctx,
                    '💳 Выберите способ оплаты:',
                    getPaymentKeyboard()
                );
                break;
            }

            case 'action_balance': {
                const credits = await db.checkCredits(userId);
                const stats = await db.getUserPhotoStats(userId);
                await sendMessage(
                    ctx,
                    `💳 Ваш баланс: ${credits} кредитов\n\n` +
                    `📊 Статистика:\n` +
                    `• Обработано фото: ${stats.total_processed}\n` +
                    `• Успешно: ${stats.successful_photos}\n` +
                    `• Ошибок: ${stats.failed_photos}`,
                    getBalanceKeyboard()
                );
                break;
            }

            case 'action_referrals': {
                const referralStats = await db.getReferralStats(userId);
                await sendMessage(
                    ctx,
                    MESSAGES.REFERRAL.STATS(referralStats.count, referralStats.earnings),
                    getReferralKeyboard(userId)
                );
                break;
            }

            case 'action_help': {
                await sendMessage(
                    ctx,
                    MESSAGES.HELP,
                    getMainKeyboard()
                );
                break;
            }

            case 'action_back': {
                const accepted = await db.hasAcceptedRules(userId);
                await sendMessage(
                    ctx,
                    MESSAGES.WELCOME(accepted),
                    accepted ? getMainKeyboard() : getInitialKeyboard()
                );
                break;
            }

            case 'action_rules': {
                await sendMessage(
                    ctx,
                    MESSAGES.RULES,
                    getInitialKeyboard()
                );
                break;
            }

            case 'action_accept_rules': {
                try {
                    await db.updateUserRules(userId);
                    await sendMessage(
                        ctx,
                        MESSAGES.RULES_ACCEPTED,
                        getMainKeyboard()
                    );
                } catch (error) {
                    console.error('Error in rules acceptance:', error);
                    await sendMessage(ctx, '❌ Произошла ошибка при принятии правил. Попробуйте позже или обратитесь в поддержку.');
                }
                break;
            }

            default: {
                console.warn('Неизвестное действие:', action);
                await sendMessage(ctx, '❌ Неизвестная команда');
            }
        }
    } catch (error) {
        console.error('Ошибка при обработке callback:', error);
        await sendMessage(ctx, '❌ Произошла ошибка. Попробуйте позже.');
    }
}