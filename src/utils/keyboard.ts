import { Markup } from 'telegraf';
import { MENU_ACTIONS, ADMIN_ACTIONS } from '../config/constants';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';

export function getMainKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💳 Купить кредиты', callback_data: 'action_buy' },
                    { text: '💰 Баланс', callback_data: 'action_balance' }
                ],
                [
                    { text: 'ℹ️ Информация', callback_data: 'action_info' },
                    { text: '❓ Помощь', callback_data: 'action_help' }
                ],
                [{ text: '◀️ Назад', callback_data: 'action_back' }]
            ]
        }
    };
}

export function getInitialKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📜 Правила использования', callback_data: 'action_rules' }],
                [{ text: '✅ Принимаю правила', callback_data: 'action_accept_rules' }],
                [{ text: '❓ Помощь', callback_data: 'action_help' }]
            ]
        }
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