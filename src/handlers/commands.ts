import { Context } from 'telegraf';
import { db } from '../services/database';
import { sendMessageWithImage } from '../utils/messages';
import { getMainKeyboard, getInitialKeyboard, getPaymentKeyboard } from '../utils/keyboard';
import { MESSAGES } from '../utils/messages';
import { PATHS } from '../config/environment';

export async function handleStart(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const username = ctx.from.username;

        await db.addUser(userId, username);
        
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