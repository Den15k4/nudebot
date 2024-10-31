import { Markup } from 'telegraf';
import { MENU_ACTIONS, ADMIN_ACTIONS } from '../config/constants';

export function getMainKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [
                Markup.button.callback('💳 Купить кредиты', 'action_buy'),
                Markup.button.callback('💰 Баланс', 'action_balance')
            ],
            [
                Markup.button.callback('ℹ️ Информация', 'action_info'),
                Markup.button.callback('❓ Помощь', 'action_help')
            ],
            [Markup.button.callback('◀️ Назад', 'action_back')]
        ])
    };
}

export function getInitialKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('📜 Правила использования', 'action_rules')],
            [Markup.button.callback('✅ Принимаю правила', 'action_accept_rules')],
            [Markup.button.callback('❓ Помощь', 'action_help')]
        ])
    };
}

export function getAdminKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [
                Markup.button.callback('📢 Рассылка', 'admin_broadcast'),
                Markup.button.callback('🕒 Отложенная рассылка', 'admin_schedule')
            ],
            [
                Markup.button.callback('📊 Статистика', 'admin_stats'),
                Markup.button.callback('❌ Отменить рассылку', 'admin_cancel_broadcast')
            ],
            [Markup.button.callback('◀️ Назад', 'action_back')]
        ])
    };
}

export function getPaymentKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('💳 Visa/MC (RUB)', 'currency_RUB')],
            [Markup.button.callback('💳 Visa/MC (KZT)', 'currency_KZT')],
            [Markup.button.callback('💳 Visa/MC (UZS)', 'currency_UZS')],
            [Markup.button.callback('💎 Криптовалюта', 'currency_CRYPTO')],
            [Markup.button.callback('◀️ Назад в меню', 'action_back')]
        ])
    };
}

export function getBroadcastCancelKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отменить рассылку', 'admin_cancel_broadcast')],
            [Markup.button.callback('◀️ Назад', 'action_back')]
        ])
    };
}