import { Context } from 'telegraf';
import { MESSAGES } from '../utils/messages';
import { db } from '../services/database';
import { sendMessage } from '../utils/messages';
import { 
    getMainKeyboard, 
    getInitialKeyboard, 
    getPaymentKeyboard, 
    getReferralKeyboard,
    getWithdrawKeyboard 
} from '../utils/keyboard';
import { logger } from '../utils/logger';

// Обработчик команды /start
export async function handleStart(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const username = ctx.from.username;
        const args = ctx.message?.text?.split(' ');
        const referralCode = args?.[1];

        logger.info('Start command received', { userId, username, referralCode });

        if (referralCode) {
            try {
                // Декодируем реферальный код
                const referrerId = parseInt(Buffer.from(referralCode, 'base64').toString('ascii'));
                if (referrerId && referrerId !== userId) {
                    await db.addUser(userId, username, referrerId);
                    // Отправляем уведомление рефереру
                    const referrerStats = await db.getReferralStats(referrerId);
                    await ctx.telegram.sendMessage(
                        referrerId,
                        MESSAGES.REFERRAL.INVITE(referrerStats.count, referrerStats.earnings)
                    );
                } else {
                    await db.addUser(userId, username);
                }
            } catch (error) {
                logger.error('Ошибка при обработке реферального кода:', error);
                await db.addUser(userId, username);
            }
        } else {
            await db.addUser(userId, username);
        }

        const hasAcceptedRules = await db.hasAcceptedRules(userId);
        if (!hasAcceptedRules) {
            await sendMessage(ctx, MESSAGES.WELCOME(false), getInitialKeyboard());
        } else {
            const credits = await db.checkCredits(userId);
            await sendMessage(
                ctx,
                MESSAGES.WELCOME(true) + `\n💳 У вас ${credits} кредитов`,
                getMainKeyboard()
            );
        }
    } catch (error) {
        logger.error('Ошибка в команде start:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}

// Обработчик команды /help
export async function handleHelp(ctx: Context): Promise<void> {
    try {
        await sendMessage(ctx, MESSAGES.HELP, getMainKeyboard());
    } catch (error) {
        logger.error('Ошибка в команде help:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}

// Обработчик команды /credits
export async function handleCredits(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;
        
        const userId = ctx.from.id;
        const credits = await db.checkCredits(userId);
        const stats = await db.getUserPhotoStats(userId);

        await sendMessage(
            ctx,
            `💳 Ваш баланс: ${credits} кредитов\n\n` +
            `📊 Статистика:\n` +
            `• Обработано фото: ${stats.total_processed}\n` +
            `• Успешно: ${stats.successful_photos}\n` +
            `• Ошибок: ${stats.failed_photos}`,
            getMainKeyboard()
        );
    } catch (error) {
        logger.error('Ошибка в команде credits:', error);
        await ctx.reply('Произошла ошибка при проверке баланса. Попробуйте позже.');
    }
}

// Обработчик команды /buy
export async function handleBuy(ctx: Context): Promise<void> {
    try {
        await sendMessage(ctx, '💳 Выберите способ оплаты:', getPaymentKeyboard());
    } catch (error) {
        logger.error('Ошибка в команде buy:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}

// Обработчик команды /referrals
export async function handleReferrals(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const referralCode = Buffer.from(userId.toString()).toString('base64');
        const stats = await db.getReferralStats(userId);
        
        await sendMessage(
            ctx,
            MESSAGES.REFERRAL.STATS(stats.count, stats.earnings),
            getReferralKeyboard(userId)
        );
    } catch (error) {
        logger.error('Ошибка в команде referrals:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}

// Обработчик команды /withdraw
export async function handleWithdraw(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;
        
        const userId = ctx.from.id;
        const args = ctx.message?.text?.split(' ');
        const paymentDetails = args?.slice(1).join(' ');

        if (!paymentDetails) {
            await sendMessage(
                ctx, 
                MESSAGES.REFERRAL.WITHDRAWAL.REQUEST,
                getWithdrawKeyboard()
            );
            return;
        }

        const stats = await db.getReferralStats(userId);
        if (stats.earnings < 100) {
            await sendMessage(ctx, MESSAGES.REFERRAL.WITHDRAWAL.INSUFFICIENT_FUNDS);
            return;
        }

        await db.createWithdrawalRequest(userId, stats.earnings, { details: paymentDetails });
        await sendMessage(ctx, MESSAGES.REFERRAL.WITHDRAWAL.SUCCESS);

    } catch (error) {
        logger.error('Ошибка в команде withdraw:', error);
        await sendMessage(ctx, MESSAGES.REFERRAL.WITHDRAWAL.ERROR);
    }
}

// Обработчик команды /admin (только для админов)
export async function handleAdmin(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        // Проверка на админа должна быть реализована в middleware
        const stats = await db.getAdminStats();
        await sendMessage(ctx, MESSAGES.ADMIN.STATS(stats));
    } catch (error) {
        logger.error('Ошибка в команде admin:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}

// Обработчик команды /broadcast (только для админов)
export async function handleBroadcast(ctx: Context): Promise<void> {
    try {
        if (!ctx.from) return;

        const args = ctx.message?.text?.split(' ');
        const broadcastMessage = args?.slice(1).join(' ');

        if (!broadcastMessage) {
            await sendMessage(ctx, MESSAGES.ADMIN.BROADCAST.START);
            return;
        }

        const users = await db.getAllUsers();
        let sent = 0;
        let failed = 0;

        for (const user of users) {
            try {
                await ctx.telegram.sendMessage(user.user_id, broadcastMessage);
                sent++;
            } catch (error) {
                failed++;
                logger.error('Ошибка при отправке рассылки:', {
                    userId: user.user_id,
                    error
                });
            }
        }

        await sendMessage(
            ctx,
            MESSAGES.ADMIN.BROADCAST.SUCCESS(sent, failed)
        );
    } catch (error) {
        logger.error('Ошибка в команде broadcast:', error);
        await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
}