import { Markup } from 'telegraf';
import { MENU_ACTIONS, ADMIN_ACTIONS } from '../config/constants';

export function getMainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [MENU_ACTIONS.BUY_CREDITS, MENU_ACTIONS.CHECK_BALANCE],
                [MENU_ACTIONS.INFORMATION, MENU_ACTIONS.HELP],
                [MENU_ACTIONS.BACK]
            ],
            resize_keyboard: true
        }
    };
}

export function getInitialKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [MENU_ACTIONS.VIEW_RULES],
                [MENU_ACTIONS.ACCEPT_RULES],
                [MENU_ACTIONS.HELP]
            ],
            resize_keyboard: true
        }
    };
}

export function getAdminKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [ADMIN_ACTIONS.BROADCAST, ADMIN_ACTIONS.SCHEDULE],
                [ADMIN_ACTIONS.STATS, ADMIN_ACTIONS.CANCEL_BROADCAST],
                [MENU_ACTIONS.BACK]
            ],
            resize_keyboard: true
        }
    };
}

export function getPaymentKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('💳 Visa/MC (RUB)', 'currency_RUB')],
            [Markup.button.callback('💳 Visa/MC (KZT)', 'currency_KZT')],
            [Markup.button.callback('💳 Visa/MC (UZS)', 'currency_UZS')],
            [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')],
            [Markup.button.callback('◀️ Назад', 'back_to_menu')]
        ])
    };
}