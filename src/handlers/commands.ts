import { Context } from 'telegraf';
import { db } from '../services/database';
import { sendMessage } from '../utils/messages';
import { getMainKeyboard, getInitialKeyboard, getPaymentKeyboard } from '../utils/keyboard';
import { MESSAGES } from '../utils/messages';

export async function handleStart(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const username = ctx.from.username;

        console.log(`Starting bot for user ${userId} (${username})`);

        await db.addUser(userId, username);

        const startPayload = (ctx.message && 'text' in ctx.message) ? 
            ctx.message.text.split(' ')[1] : null;

        if (startPayload) {
            const referrerId = parseInt(startPayload);
            if (!isNaN(referrerId) && referrerId !== userId) {
                await db.addReferral(userId, referrerId);
                await sendMessage(
                    ctx,
                    MESSAGES.REFERRAL.INVITE(referrerId),
                    getInitialKeyboard()
                );
                return;
            }
        }
        
        const accepted = await db.hasAcceptedRules(userId);

        if (!accepted) {
            await sendMessage(
                ctx,
                MESSAGES.WELCOME(false),
                getInitialKeyboard()
            );
        } else {
            await sendMessage(
                ctx,
                MESSAGES.WELCOME(true),
                getMainKeyboard()
            );
        }
    } catch (error) {
        console.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка при запуске бота. Попробуйте позже.');
    }
}

export async function handleReferrals(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const stats = await db.getReferralStats(userId);
        
        await sendMessage(
            ctx,
            MESSAGES.REFERRAL.STATS(stats.count, stats.earnings),
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при получении реферальной статистики:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}

export async function handleCredits(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;
        
        const credits = await db.checkCredits(ctx.from.id);
        const stats = await db.getPhotoStats(ctx.from.id);
        await sendMessage(
            ctx,
            `💳 У вас ${credits} кредитов\n\n` +
            `📊 Ваша статистика:\n` +
            `• Обработано фото: ${stats.total_processed}\n` +
            `• Успешно: ${stats.successful_photos}\n` +
            `• Ошибок: ${stats.failed_photos}`,
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при проверке кредитов:', error);
        await ctx.reply('Произошла ошибка при проверке кредитов. Попробуйте позже.');
    }
}

export async function handleBuy(ctx: Context): Promise<void> {
    await sendMessage(
        ctx,
        '💳 Выберите способ оплаты:',
        getPaymentKeyboard()
    );
}

export async function handleHelp(ctx: Context): Promise<void> {
    await sendMessage(
        ctx,
        MESSAGES.HELP,
        getMainKeyboard()
    );
}

export async function handleAcceptRules(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        await db.updateAcceptedRules(ctx.from.id);
        
        await sendMessage(
            ctx,
            MESSAGES.RULES_ACCEPTED,
            getMainKeyboard()
        );
    } catch (error) {
        console.error('Ошибка при принятии правил:', error);
        await ctx.reply('❌ Произошла ошибка при принятии правил. Попробуйте позже или обратитесь в поддержку.');
    }
}

export async function handleBack(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const accepted = await db.hasAcceptedRules(ctx.from.id);
        if (!accepted) {
            await sendMessage(
                ctx,
                MESSAGES.WELCOME(false),
                getInitialKeyboard()
            );
        } else {
            await sendMessage(
                ctx,
                MESSAGES.WELCOME(true),
                getMainKeyboard()
            );
        }
    } catch (error) {
        console.error('Ошибка при возврате в главное меню:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}