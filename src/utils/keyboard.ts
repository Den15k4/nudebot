import { Markup } from 'telegraf';
import { InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';
import { MENU_ACTIONS } from '../config/constants';
import { logger } from '../index';

// Типы для клавиатур
interface KeyboardOptions {
    userId?: number;
    hideBackButton?: boolean;
    disabledButtons?: string[];
}

// Базовая функция для создания клавиатуры с обработкой ошибок
function createKeyboard(buttons: InlineKeyboardButton[][], options: KeyboardOptions = {}) {
    try {
        return {
            reply_markup: {
                inline_keyboard: buttons.filter(row => row.length > 0)
            }
        };
    } catch (error) {
        logger.error('Ошибка при создании клавиатуры:', error);
        // Возвращаем простую клавиатуру в случае ошибки
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
        const buttons: InlineKeyboardButton[][] = [];

        // Первый ряд кнопок
        const firstRow: InlineKeyboardButton[] = [];
        if (!disabledButtons.includes('process_photo')) {
            firstRow.push({ text: '📸 Обработать фото', callback_data: 'action_process_photo' });
        }
        if (!disabledButtons.includes('buy')) {
            firstRow.push({ text: '💳 Купить кредиты', callback_data: 'action_buy' });
        }
        if (firstRow.length > 0) buttons.push(firstRow);

        // Второй ряд кнопок
        const secondRow: InlineKeyboardButton[] = [];
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
        const buttons: InlineKeyboardButton[][] = [
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
        const buttons: InlineKeyboardButton[][] = [
            [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
            [{ text: '📨 Рассылка', callback_data: 'admin_broadcast' }],
            [{ text: '⚙️ Настройки', callback_data: 'admin_settings' }]
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
        const buttons: InlineKeyboardButton[][] = [
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

// Реферальная клавиатура
export function getReferralKeyboard(userId: number) {
    try {
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
    } catch (error) {
        logger.error('Ошибка в getReferralKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура обработки фото
export function getPhotoProcessingKeyboard() {
    try {
        return {
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('❌ Отменить обработку', 'action_cancel_processing')],
                [Markup.button.callback('◀️ Назад в меню', 'action_back')]
            ])
        };
    } catch (error) {
        logger.error('Ошибка в getPhotoProcessingKeyboard:', error);
        return getErrorKeyboard();
    }
}

// Клавиатура баланса
export function getBalanceKeyboard() {
    try {
        return {
            reply_markup: Markup.inlineKeyboard([
                [
                    Markup.button.callback('💳 Пополнить', 'action_buy'),
                    Markup.button.callback('📊 История', 'action_history')
                ],
                [Markup.button.callback('◀️ Назад в меню', 'action_back')]
            ])
        };
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
export function getPackageKeyboard(packages: Array<{id: number, description: string, price: number}>, currency: string) {
    try {
        const buttons = packages.map(pkg => ([{
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
export function disableButtons(keyboard: any, buttonsToDisable: string[]) {
    try {
        if (!keyboard.reply_markup?.inline_keyboard) return keyboard;

        const newKeyboard = JSON.parse(JSON.stringify(keyboard));
        newKeyboard.reply_markup.inline_keyboard = newKeyboard.reply_markup.inline_keyboard
            .map((row: InlineKeyboardButton[]) =>
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
            .filter((row: InlineKeyboardButton[]) => row.length > 0);

        return newKeyboard;
    } catch (error) {
        logger.error('Ошибка в disableButtons:', error);
        return keyboard;
    }
}