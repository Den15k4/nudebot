import { Context } from 'telegraf';
import { MENU_ACTIONS } from '../config/constants';
import { ENV } from '../config/environment';
import { db } from '../services/database';
import { sendMessageWithImage } from '../utils/messages';
import { getInitialKeyboard } from '../utils/keyboard';
import { PATHS } from '../config/environment';

export async function isAdmin(userId: string): Promise<boolean> {
    return ENV.ADMIN_IDS.includes(userId);
}

export async function requireAcceptedRules(ctx: Context, next: () => Promise<void>): Promise<void> {
    try {
        const userId = ctx.from?.id.toString();
        
        if (userId && await isAdmin(userId)) {
            return next();
        }

        const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
        
        if (
            messageText === '/start' || 
            messageText === MENU_ACTIONS.BACK || 
            messageText === MENU_ACTIONS.VIEW_RULES ||
            messageText === MENU_ACTIONS.ACCEPT_RULES
        ) {
            return next();
        }

        if (!ctx.from?.id) {
            return;
        }

        const accepted = await db.hasAcceptedRules(ctx.from.id);
        if (!accepted) {
            await sendMessageWithImage(
                ctx,
                PATHS.ASSETS.WELCOME,
                '⚠️ Для использования бота необходимо принять правила.\n' +
                'Используйте команду /start для просмотра правил.',
                getInitialKeyboard()
            );
            return;
        }

        return next();
    } catch (error) {
        console.error('Ошибка в middleware проверки правил:', error);
        return next();
    }
}