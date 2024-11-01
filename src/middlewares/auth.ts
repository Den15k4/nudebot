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
        if (!ctx.from?.id) return;

        const userId = ctx.from.id.toString();
        
        // Пропускаем админов
        if (await isAdmin(userId)) {
            return next();
        }

        // Список разрешенных действий без принятия правил
        const allowedActions = ['/start', 'action_rules', 'action_accept_rules', 'action_help'];
        
        // Проверяем текст сообщения или callback данные
        const action = ctx.callbackQuery?.data || 
                      (ctx.message && 'text' in ctx.message ? ctx.message.text : '');

        if (allowedActions.includes(action)) {
            return next();
        }

        const accepted = await db.hasAcceptedRules(ctx.from.id);
        if (!accepted) {
            // Отправляем сообщение только если это не callback
            if (!ctx.callbackQuery) {
                await sendMessageWithImage(
                    ctx,
                    PATHS.ASSETS.WELCOME,
                    '⚠️ Для использования бота необходимо принять правила.\n' +
                    'Нажмите на кнопку "Принимаю правила" ниже.',
                    getInitialKeyboard()
                );
            }
            return;
        }

        return next();
    } catch (error) {
        console.error('Ошибка в middleware проверки правил:', error);
        return next();
    }
}