import { Markup } from 'telegraf';
import { 
    CustomInlineKeyboardButton, 
    KeyboardOptions 
} from '../types/interfaces';
import { MENU_ACTIONS } from '../config/constants';
import { logger } from '../utils/logger';

// Базовая функция для создания клавиатуры с обработкой ошибок
function createKeyboard(buttons: CustomInlineKeyboardButton[][], options: KeyboardOptions = {}) {
    try {
        return {
            reply_markup: {
                inline_keyboard: buttons.filter(row => row.length > 0)
            }
        };
    } catch (error) {
        logger.error('Ошибка при создании клавиатуры:', error);
        return {
            reply_markup: {
                inline_keyboard: [[{ text: '◀️ В главное меню', callback_data: 'action_back' }]]
            }
        };
    }
}

// Основное меню
export function getMainKeyboard(options: KeyboardOptions = {}) {
    try {
        const { disabledButtons = [] } = options;
        const buttons: CustomInlineKeyboardButton[][] = [];

        // Первый ряд кнопок
        const firstRow: CustomInlineKeyboardButton[] = [];
        if (!disabledButtons.includes('process_photo')) {
            firstRow.push({ text: '📸 Обработать фото', callback_data: 'action_process_photo' });
        }
        if (!disabledButtons.includes('buy')) {
            firstRow.push({ text: '💳 Купить кредиты', callback_data: 'action_buy' });
        }
        if (firstRow.length > 0) buttons.push(firstRow);

        // Второй ряд кнопок
        const secondRow: CustomInlineKeyboardButton[] = [];
        if (!disabledButtons.includes('balance')) {
            secondRow.push({ text: '💰 Баланс', callback_data: 'action_balance' });
        }
        if (!disabledButtons.includes('referrals')) {
            secondRow.push({ text: '👥 Рефералы', callback_data: 'action_referrals' });
        }
        if (secondRow.length > 0) buttons.push(secondRow);

        // Кнопка помощи
        if (!disabledButtons.includes('help')) {
            buttons.push([{ text: '❓ Помощь', callback_data: 'action_help' }]);
        }

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getMainKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура для новых пользователей
export function getInitialKeyboard(options: KeyboardOptions = {}) {
    try {
        const buttons: CustomInlineKeyboardButton[][] = [
            [{ text: '📜 Правила использования', callback_data: 'action_rules' }],
            [{ text: '✅ Принимаю правила', callback_data: 'action_accept_rules' }],
            [{ text: '❓ Помощь', callback_data: 'action_help' }]
        ];

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getInitialKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Админ-панель
export function getAdminKeyboard(options: KeyboardOptions = {}) {
    try {
        const buttons: CustomInlineKeyboardButton[][] = [
            [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
            [{ text: '📨 Рассылка', callback_data: 'admin_broadcast' }],
            [{ text: '⚙️ Настройки', callback_data: 'admin_settings' }],
            [{ text: '💰 Выводы', callback_data: 'admin_withdrawals' }]
        ];

        if (!options.hideBackButton) {
            buttons.push([{ text: '◀️ Назад', callback_data: 'action_back' }]);
        }

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getAdminKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура оплаты
export function getPaymentKeyboard(options: KeyboardOptions = {}) {
    try {
        const buttons: CustomInlineKeyboardButton[][] = [
            [{ text: '💳 Visa/MC/MIR', callback_data: 'currency_RUB' }],
            [{ text: '💳 Visa/MC [KZT]', callback_data: 'currency_KZT' }],
            [{ text: '💳 Visa/MC [UZS]', callback_data: 'currency_UZS' }],
            [{ text: '💸 СБП', callback_data: 'currency_RUB_SBP' }],
            [{ text: '💎 Crypto', callback_data: 'currency_CRYPTO' }]
        ];

        if (!options.hideBackButton) {
            buttons.push([{ text: '◀️ Назад', callback_data: 'action_back' }]);
        }

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getPaymentKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура реферальной системы
export function getReferralKeyboard(userId: number) {
    try {
        const buttons: CustomInlineKeyboardButton[][] = [
            [
                { text: '📊 Статистика', callback_data: 'referral_stats' },
                { text: '💰 Заработок', callback_data: 'referral_earnings' }
            ],
            [{ 
                text: '🔗 Поделиться', 
                url: `https://t.me/${process.env.BOT_USERNAME}?start=${Buffer.from(userId.toString()).toString('base64')}` 
            }],
            [{ text: '💰 Вывести средства', callback_data: 'action_withdraw' }],
            [{ text: '◀️ Назад в меню', callback_data: 'action_back' }]
        ];

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getReferralKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура для вывода средств
export function getWithdrawKeyboard() {
    try {
        const buttons: CustomInlineKeyboardButton[][] = [
            [
                { text: '💳 Банковская карта', callback_data: 'withdraw_card' },
                { text: '💎 USDT (TRC20)', callback_data: 'withdraw_crypto' }
            ],
            [{ text: '◀️ Назад', callback_data: 'action_referrals' }]
        ];

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getWithdrawKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура обработки фото
export function getPhotoProcessingKeyboard() {
    try {
        const buttons: CustomInlineKeyboardButton[][] = [
            [{ text: '❌ Отменить обработку', callback_data: 'action_cancel_processing' }],
            [{ text: '◀️ Назад в меню', callback_data: 'action_back' }]
        ];

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getPhotoProcessingKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура баланса
export function getBalanceKeyboard() {
    try {
        const buttons: CustomInlineKeyboardButton[][] = [
            [
                { text: '💳 Пополнить', callback_data: 'action_buy' },
                { text: '📊 История', callback_data: 'action_history' }
            ],
            [{ text: '◀️ Назад в меню', callback_data: 'action_back' }]
        ];

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getBalanceKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура для ошибок
export function getErrorKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '◀️ В главное меню', callback_data: 'action_back' }],
                [{ text: '❓ Помощь', callback_data: 'action_help' }]
            ]
        }
    };
}

// Динамическая генерация клавиатуры пакетов
export function getPackageKeyboard(
    packages: Array<{id: number, description: string, price: number}>, 
    currency: string
) {
    try {
        const buttons: CustomInlineKeyboardButton[][] = packages.map(pkg => ([{
            text: `${pkg.description} - ${pkg.price} ${currency}`,
            callback_data: `buy_${pkg.id}_${currency}`
        }]));

        buttons.push([{ text: '◀️ Назад', callback_data: 'action_back' }]);

        return createKeyboard(buttons);
    } catch (error) {
        logger.error('Ошибка в getPackageKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Функция для динамического отключения кнопок
export function disableButtons(
    keyboard: any, 
    buttonsToDisable: string[]
): { reply_markup: { inline_keyboard: CustomInlineKeyboardButton[][] } } {
    try {
        if (!keyboard.reply_markup?.inline_keyboard) return keyboard;

        const newKeyboard = JSON.parse(JSON.stringify(keyboard));
        newKeyboard.reply_markup.inline_keyboard = newKeyboard.reply_markup.inline_keyboard
            .map((row: CustomInlineKeyboardButton[]) =>
                row.map(button => {
                    if (buttonsToDisable.includes(button.callback_data || '')) {
                        return {
                            ...button,
                            callback_data: 'disabled',
                            text: `${button.text} (недоступно)`
                        };
                    }
                    return button;
                })
            )
            .filter((row: CustomInlineKeyboardButton[]) => row.length > 0);

        return newKeyboard;
    } catch (error) {
        logger.error('Ошибка в disableButtons:', error);
        return keyboard;
    }
}