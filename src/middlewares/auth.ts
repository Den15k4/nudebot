import { Context } from 'telegraf';
import { ENV } from '../config/environment';
import { db } from '../services/database';
import { logger } from '../utils/logger';
import { sendMessage } from '../utils/messages';
import { getInitialKeyboard } from '../utils/keyboard';
import { MESSAGES } from '../utils/messages';

// Проверка на администратора
export function isAdmin(userId: string): boolean {
    return ENV.ADMIN_IDS.includes(userId);
}

// Middleware проверки принятия правил
export async function requireAcceptedRules(ctx: Context, next: () => Promise<void>): Promise<void> {
    try {
        if (!ctx.from?.id) return;

        const userId = ctx.from.id.toString();
        
        // Пропускаем админов
        if (isAdmin(userId)) {
            return next();
        }

        // Список разрешенных действий без принятия правил
        const allowedActions = [
            '/start',
            'action_rules',
            'action_accept_rules',
            'action_help'
        ];
        
        // Проверяем текст сообщения или callback данные
        let action: string | undefined;
        
        if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
            action = ctx.callbackQuery.data;
        } else if (ctx.message && 'text' in ctx.message) {
            action = ctx.message.text;
        }

        // Пропускаем разрешенные действия
        if (action && allowedActions.includes(action)) {
            return next();
        }

        // Проверяем принятие правил
        const accepted = await db.hasAcceptedRules(ctx.from.id);
        if (!accepted) {
            // Отправляем сообщение только если это не callback
            if (!ctx.callbackQuery) {
                await sendMessage(
                    ctx,
                    MESSAGES.WELCOME(false),
                    getInitialKeyboard()
                );
            } else {
                await ctx.answerCbQuery('⚠️ Необходимо принять правила использования');
            }
            return;
        }

        return next();
    } catch (error) {
        logger.error('Ошибка в middleware проверки правил:', error);
        return next();
    }
}

// Middleware проверки администратора
export async function requireAdmin(ctx: Context, next: () => Promise<void>): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id.toString();
        if (!isAdmin(userId)) {
            await ctx.reply('⚠️ Недостаточно прав для выполнения действия');
            return;
        }

        return next();
    } catch (error) {
        logger.error('Ошибка в middleware проверки админа:', error);
        return next();
    }
}

// Middleware для блокировки спама
export async function rateLimit(ctx: Context, next: () => Promise<void>): Promise<void> {
    if (!ctx.from) return;

    const userId = ctx.from.id;
    const now = Date.now();
    const userLastAction = userActions.get(userId) || 0;

    if (now - userLastAction < 1000) { // 1 секунда между действиями
        await ctx.reply('⚠️ Слишком частые запросы. Пожалуйста, подождите.');
        return;
    }

    userActions.set(userId, now);
    return next();
}

// Кэш последних действий пользователей
const userActions = new Map<number, number>();

// Очистка старых записей каждые 5 минут
setInterval(() => {
    const now = Date.now();
    for (const [userId, lastAction] of userActions.entries()) {
        if (now - lastAction > 5 * 60 * 1000) { // 5 минут
            userActions.delete(userId);
        }
    }
}, 5 * 60 * 1000);

// Middleware проверки блокировки
export async function checkBan(ctx: Context, next: () => Promise<void>): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const isBanned = await db.isUserBanned(userId);

        if (isBanned) {
            await ctx.reply('⚠️ Ваш аккаунт заблокирован. Обратитесь в поддержку.');
            return;
        }

        return next();
    } catch (error) {
        logger.error('Ошибка в middleware проверки бана:', error);
        return next();
    }
}

// Middleware для логирования действий
export async function logUserAction(ctx: Context, next: () => Promise<void>): Promise<void> {
    if (!ctx.from) return;

    const userId = ctx.from.id;
    let action = '';

    // Определяем тип действия
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
        action = ctx.callbackQuery.data;
    } else if (ctx.message && 'text' in ctx.message) {
        action = ctx.message.text;
    }

    logger.info('Действие пользователя:', {
        userId,
        action,
        timestamp: new Date().toISOString()
    });

    return next();
}

// Middleware для проверки наличия кредитов
export async function checkCredits(ctx: Context, next: () => Promise<void>): Promise<void> {
    try {
        if (!ctx.from) return;

        const userId = ctx.from.id;
        const credits = await db.checkCredits(userId);

        if (credits <= 0) {
            await sendMessage(
                ctx,
                MESSAGES.ERRORS.INSUFFICIENT_CREDITS,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 Купить кредиты', callback_data: 'action_buy' }],
                            [{ text: '◀️ В главное меню', callback_data: 'action_back' }]
                        ]
                    }
                }
            );
            return;
        }

        return next();
    } catch (error) {
        logger.error('Ошибка в middleware проверки кредитов:', error);
        return next();
    }
}

// Экспорт всех middleware в одном объекте
export const middlewares = {
    requireAcceptedRules,
    requireAdmin,
    rateLimit,
    checkBan,
    logUserAction,
    checkCredits
};