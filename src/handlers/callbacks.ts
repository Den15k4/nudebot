import { Context } from 'telegraf';
import { db } from '../services/database';
import { sendMessageWithImage } from '../utils/messages';
import { getMainKeyboard, getInitialKeyboard, getPaymentKeyboard } from '../utils/keyboard';
import { MESSAGES } from '../utils/messages';
import { PATHS } from '../config/environment';
import { isAdmin } from '../middlewares/auth';
import * as commandHandlers from './commands';
import * as adminHandlers from './admin';
import { paymentService } from '../services/payment';

export async function handleCallbacks(ctx: Context) {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
        return;
    }

    const action = ctx.callbackQuery.data;
    const userId = ctx.from?.id;

    if (!userId) return;

    try {
        await ctx.answerCbQuery(); // Убираем "часики" с кнопки

        switch (action) {
            case 'action_buy':
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.PAYMENT,
                    '💳 Выберите способ оплаты:',
                    getPaymentKeyboard()
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

            // Админские действия
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

            // Обработка валют и платежей
            case action.match(/^currency_(.+)/)?.input:
                const currency = action.split('_')[1];
                if (!await handleCurrencySelection(ctx, userId, currency)) {
                    await sendMessageWithImage(
                        ctx,
                        PATHS.ASSETS.PAYMENT,
                        '❌ Неподдерживаемая валюта',
                        getPaymentKeyboard()
                    );
                }
                break;

            case action.match(/^buy_(\d+)_(.+)/)?.input:
                const [_, packageId, curr] = action.split('_');
                await handlePackageSelection(ctx, userId, parseInt(packageId), curr);
                break;

            default:
                console.log('Неизвестное действие:', action);
        }
    } catch (error) {
        console.error('Ошибка при обработке callback:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}

async function handleCurrencySelection(ctx: Context, userId: number, currency: string): Promise<boolean> {
    try {
        const packages = paymentService.getAvailablePackages(currency as any);
        if (packages.length === 0) return false;

        const buttons = packages.map(pkg => ([
            Markup.button.callback(
                `${pkg.description} - ${pkg.prices[currency as any]} ${currency}`,
                `buy_${pkg.id}_${currency}`
            )
        ]));
        buttons.push([Markup.button.callback('◀️ Назад', 'action_back')]);

        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.PAYMENT,
            `💳 Выберите пакет кредитов (цены в ${currency}):`,
            { reply_markup: Markup.inlineKeyboard(buttons) }
        );
        return true;
    } catch (error) {
        console.error('Ошибка при выборе валюты:', error);
        return false;
    }
}

async function handlePackageSelection(ctx: Context, userId: number, packageId: number, currency: string) {
    try {
        const paymentUrl = await paymentService.createPayment(userId, packageId, currency as any);
        const package_ = paymentService.getAvailablePackages(currency as any).find(p => p.id === packageId);

        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.PAYMENT_PROCESS,
            `🔄 Для оплаты ${package_?.description} перейдите по кнопке ниже.\n\n` +
            'После оплаты кредиты будут автоматически зачислены на ваш счет.',
            {
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('💳 Перейти к оплате', paymentUrl)],
                    [Markup.button.callback('◀️ Назад к выбору пакета', `currency_${currency}`)]
                ])
            }
        );
    } catch (error) {
        console.error('Ошибка при создании платежа:', error);
        await ctx.reply('❌ Произошла ошибка при создании платежа. Попробуйте позже.');
    }
}