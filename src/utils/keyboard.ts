import { Markup } from 'telegraf';
import { MENU_ACTIONS } from '../config/constants';

export function getMainKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📸 Обработать фото', callback_data: 'action_process_photo' },
                    { text: '💳 Купить кредиты', callback_data: 'action_buy' }
                ],
                [
                    { text: '💰 Баланс', callback_data: 'action_balance' },
                    { text: '👥 Рефералы', callback_data: 'action_referrals' }
                ],
                [
                    { text: '❓ Помощь', callback_data: 'action_help' }
                ]
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
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Статистика', callback_data: 'admin_stats' }
                ],
                [{ text: '◀️ Назад', callback_data: 'action_back' }]
            ]
        }
    };
}

export function getPaymentKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '💳 Visa/MC/MIR', callback_data: 'currency_RUB' }],
                [{ text: '💳 Visa/MC [KZT]', callback_data: 'currency_KZT' }],
                [{ text: '💳 Visa/MC [UZS]', callback_data: 'currency_UZS' }],
                [{ text: '💸 СБП', callback_data: 'currency_RUB_SBP' }],
                [{ text: '💎 Crypto', callback_data: 'currency_CRYPTO' }],
                [{ text: '◀️ Назад', callback_data: 'action_back' }]
            ]
        }
    };
}

export function getReferralKeyboard(userId: number) {
    return {
        reply_markup: Markup.inlineKeyboard([
            [
                Markup.button.callback('📊 Статистика', 'referral_stats'),
                Markup.button.callback('💰 Заработок', 'referral_earnings')
            ],
            [Markup.button.url('🔗 Поделиться', `https://t.me/${process.env.BOT_USERNAME}?start=${userId}`)],
            [Markup.button.callback('◀️ Назад в меню', 'action_back')]
        ])
    };
}

export function getPhotoProcessingKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отменить обработку', 'action_cancel_processing')],
            [Markup.button.callback('◀️ Назад в меню', 'action_back')]
        ])
    };
}

export function getBalanceKeyboard() {
    return {
        reply_markup: Markup.inlineKeyboard([
            [
                Markup.button.callback('💳 Пополнить', 'action_buy'),
                Markup.button.callback('📊 История', 'action_history')
            ],
            [Markup.button.callback('◀️ Назад в меню', 'action_back')]
        ])
    };
}