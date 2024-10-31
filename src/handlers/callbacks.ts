import { Context } from 'telegraf';
import { SupportedCurrency } from '../types/interfaces';
import { paymentService } from '../services/payment';
import { sendMessageWithImage } from '../utils/messages';
import { PATHS } from '../config/environment';
import { getMainKeyboard, getInitialKeyboard, getAdminKeyboard } from '../utils/keyboard';
import { db } from '../services/database';
import { MESSAGES } from '../utils/messages';
import { isAdmin } from '../middlewares/auth';
import * as adminHandlers from './admin';

export async function handleCallbacks(ctx: Context) {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
        return;
    }

    const action = ctx.callbackQuery.data;
    const userId = ctx.from?.id;

    if (!userId) return;

    try {
        await ctx.answerCbQuery();

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
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.BALANCE,
                    `💳 У вас ${credits} кредитов`,
                    getMainKeyboard()
                );
                break;

            case 'action_referrals':
                const stats = await db.getReferralStats(userId);
                const transactions = await db.getRecentReferralTransactions(userId);
                
                let message = '👥 <b>Ваша реферальная программа:</b>\n\n' +
                    `🔢 Количество рефералов: ${stats.count}\n` +
                    `💰 Заработано: ${stats.earnings}₽\n\n` +
                    '🔗 Ваша реферальная ссылка:\n' +
                    `https://t.me/${ctx.botInfo?.username}?start=${userId}`;

                if (transactions.length > 0) {
                    message += '\n\n📝 Последние начисления:\n';
                    transactions.forEach(t => {
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

            case 'admin_broadcast':
                if (await isAdmin(userId.toString())) {
                    await adminHandlers.handleBroadcastCommand(ctx);
                }
                break;

            case 'admin_schedule':
                if (await isAdmin(userId.toString())) {
                    await adminHandlers.handleScheduleCommand(ctx);
                }
                break;

            case 'admin_stats':
                if (await isAdmin(userId.toString())) {
                    await adminHandlers.handleStats(ctx);
                }
                break;

            case 'admin_cancel_broadcast':
                if (await isAdmin(userId.toString())) {
                    await adminHandlers.handleCancelBroadcast(ctx);
                }
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
}

async function handleCurrencySelection(ctx: Context, userId: number, currency: SupportedCurrency): Promise<boolean> {
    try {
        const packages = paymentService.getAvailablePackages(currency);
        if (packages.length === 0) return false;

        const buttons = packages.map(pkg => ([{
            text: `${pkg.description} - ${pkg.prices[currency]} ${currency}`,
            callback_data: `buy_${pkg.id}_${currency}`
        }]));
        
        buttons.push([{
            text: '◀️ Назад',
            callback_data: 'action_back'
        }]);

        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.PAYMENT,
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
        return false;
    }
}

async function handlePackageSelection(ctx: Context, userId: number, packageId: number, currency: SupportedCurrency) {
    try {
        const paymentUrl = await paymentService.createPayment(userId, packageId, currency);
        const package_ = paymentService.getAvailablePackages(currency).find(p => p.id === packageId);

        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.PAYMENT_PROCESS,
            `🔄 Для оплаты ${package_?.description} перейдите по кнопке ниже.\n\n` +
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
        await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
    }
}
