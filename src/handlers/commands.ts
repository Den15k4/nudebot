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

        console.log(`Starting bot for user ${userId} (${username})`);

        // Создаем пользователя с проверкой результата
        await db.addUser(userId, username);

        // Проверяем наличие реферального кода
        const startPayload = (ctx.message && 'text' in ctx.message) ? 
            ctx.message.text.split(' ')[1] : null;

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
        
        // Проверяем статус принятия правил
        const accepted = await db.hasAcceptedRules(userId);
        console.log(`Rules acceptance status for user ${userId}: ${accepted}`);

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
    } catch (error) {
        console.error('Ошибка при получении реферальной статистики:', error);
        await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
    }
}

export async function handleCredits(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;
        
        const credits = await db.checkCredits(ctx.from.id);
        const stats = await db.getUserPhotoStats(ctx.from.id);
        await sendMessageWithImage(
            ctx,
            PATHS.ASSETS.BALANCE,
            `💳 У вас ${credits} кредитов\n\n` +
            `📊 Ваша статистика:\n` +
            `• Обработано фото: ${stats.photos_processed}\n` +
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

        console.log(`Handling rules acceptance for user ${ctx.from.id}`);

        await db.updateAcceptedRules(ctx.from.id);
        console.log(`Rules acceptance updated for user ${ctx.from.id}`);

        // Проверяем статус после обновления
        const isAccepted = await db.hasAcceptedRules(ctx.from.id);
        console.log(`Verified rules acceptance status for user ${ctx.from.id}: ${isAccepted}`);

        if (isAccepted) {
            await sendMessageWithImage(
                ctx,
                PATHS.ASSETS.WELCOME,
                MESSAGES.RULES_ACCEPTED,
                getMainKeyboard()
            );
            console.log(`Sent welcome message to user ${ctx.from.id}`);
        } else {
            console.log(`Failed to verify rules acceptance for user ${ctx.from.id}`);
            throw new Error('Failed to update rules acceptance status');
        }
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