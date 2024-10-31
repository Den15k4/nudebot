import { Markup } from 'telegraf';
import { MENU_ACTIONS, ADMIN_ACTIONS } from '../config/constants';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';

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

export function getReferralKeyboard(userId: number) {
    return {
        reply_markup: Markup.inlineKeyboard([
            [
                Markup.button.callback('📊 Статистика', 'referral_stats'),
                Markup.button.callback('💰 Заработок', 'referral_earnings')
            ],
            [Markup.button.url('🔗 Поделиться', `https://t.me/share/url?url=https://t.me/${process.env.BOT_USERNAME}?start=${userId}`)],
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

// Клавиатура для подтверждения действий
export function getConfirmationKeyboard(action: string) {
    return {
        reply_markup: Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Да', `confirm_${action}`),
                Markup.button.callback('❌ Нет', 'action_back')
            ]
        ])
    };
}

// Клавиатура для пагинации
export function getPaginationKeyboard(currentPage: number, totalPages: number, baseAction: string) {
    const buttons: InlineKeyboardButton[][] = [];
    
    const navigationRow: InlineKeyboardButton[] = [];
    if (currentPage > 1) {
        navigationRow.push(Markup.button.callback('⬅️', `${baseAction}_page_${currentPage - 1}`));
    }
    navigationRow.push(Markup.button.callback(`${currentPage}/${totalPages}`, 'ignore'));
    if (currentPage < totalPages) {
        navigationRow.push(Markup.button.callback('➡️', `${baseAction}_page_${currentPage + 1}`));
    }
    
    buttons.push(navigationRow);
    buttons.push([Markup.button.callback('◀️ Назад', 'action_back')]);
    
    return {
        reply_markup: Markup.inlineKeyboard(buttons)
    };
}