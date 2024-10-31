import { Context } from 'telegraf';
import { db } from '../services/database';
import { sendMessageWithImage } from '../utils/messages';
import { getMainKeyboard, getInitialKeyboard, getPaymentKeyboard } from '../utils/keyboard';
import { MESSAGES } from '../utils/messages';
import { PATHS } from '../config/environment';

export async function handleReferrals(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
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
    } catch (error) {
        console.error('Ошибка при получении реферальной статистики:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}

export async function handleStart(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const username = ctx.from.username;

        // Проверяем наличие реферального кода
        const startPayload = (ctx.message && 'text' in ctx.message) ? 
            ctx.message.text.split(' ')[1] : null;

        await db.addUser(userId, username);
        
        // Обработка реферальной ссылки
        if (startPayload) {
            const referrerId = parseInt(startPayload);
            if (!isNaN(referrerId) && referrerId !== userId) {
                await db.addReferral(userId, referrerId);
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.REFERRAL,
                    '🎉 Вы присоединились по реферальной ссылке!\n' +
                    'Ваш пригласивший получит 50% от ваших оплат.',
                    getInitialKeyboard()
                );
                return;
            }
        }
        
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
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
}

export async function handleCredits(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;
        
        const credits = await db.checkCredits(ctx.from.id);
        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.BALANCE,
            `💳 У вас ${credits} кредитов`,
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при проверке кредитов:', error);
        await ctx.reply('Произошла ошибка при проверке кредитов. Попробуйте позже.');
    }
}

export async function handleBuy(ctx: Context): Promise<void> {
    await sendMessageWithImage(
        ctx,
        PATHS.ASSETS.PAYMENT,
        '💳 Выберите способ оплаты:',
        getPaymentKeyboard()
    );
}

export async function handleHelp(ctx: Context): Promise<void> {
    await sendMessageWithImage(
        ctx,
        PATHS.ASSETS.WELCOME,
        MESSAGES.HELP,
        getMainKeyboard()
    );
}

export async function handleRules(ctx: Context): Promise<void> {
    await sendMessageWithImage(
        ctx,
        PATHS.ASSETS.WELCOME,
        MESSAGES.RULES,
        getInitialKeyboard()
    );
}

export async function handleAcceptRules(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        await db.updateUserCredits(ctx.from.id, 0); // Обновляем статус правил
        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.WELCOME,
            MESSAGES.RULES_ACCEPTED,
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при принятии правил:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}

export async function handleBack(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const accepted = await db.hasAcceptedRules(ctx.from.id);
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
    } catch (error) {
        console.error('Ошибка при возврате в главное меню:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}