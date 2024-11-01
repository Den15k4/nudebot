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
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Статистика', callback_data: 'admin_stats' },
                    { text: '📢 Рассылка', callback_data: 'admin_broadcast' }
                ],
                [
                    { text: '🎉 Акции', callback_data: 'admin_special_offers' },
                    { text: '💾 Бэкапы', callback_data: 'admin_backups' }
                ],
                [
                    { text: '📅 Отложенная рассылка', callback_data: 'admin_schedule' }
                ],
                [
                    { text: '❌ Отменить рассылку', callback_data: 'admin_cancel_broadcast' }
                ],
                [{ text: '◀️ Назад', callback_data: 'action_back' }]
            ]
        }
    };
}

export function getAdminStatsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Детальная статистика', callback_data: 'admin_detailed_stats' },
                    { text: '📈 Графики', callback_data: 'admin_stats_graphs' }
                ],
                [
                    { text: '📥 Выгрузить отчёт', callback_data: 'admin_export_stats' },
                    { text: '🔄 Обновить', callback_data: 'admin_stats_refresh' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_back' }]
            ]
        }
    };
}

export function getSpecialOffersKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '➕ Создать акцию', callback_data: 'admin_create_offer' },
                    { text: '📝 Редактировать', callback_data: 'admin_edit_offers' }
                ],
                [
                    { text: '❌ Деактивировать', callback_data: 'admin_deactivate_offer' },
                    { text: '📊 Статистика акций', callback_data: 'admin_offers_stats' }
                ],
                [
                    { text: '✉️ Создать рассылку', callback_data: 'admin_offer_broadcast' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_back' }]
            ]
        }
    };
}

export function getAdminBackupsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📥 Создать бэкап', callback_data: 'admin_create_backup' },
                    { text: '📤 Восстановить', callback_data: 'admin_restore_backup' }
                ],
                [
                    { text: '📋 История', callback_data: 'admin_backup_history' },
                    { text: '⚙️ Настройки', callback_data: 'admin_backup_settings' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_back' }]
            ]
        }
    };
}

export function getAdminBroadcastKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📢 Всем пользователям', callback_data: 'admin_broadcast_all' },
                    { text: '🎯 Выборочная', callback_data: 'admin_broadcast_select' }
                ],
                [
                    { text: '📅 Отложенная', callback_data: 'admin_schedule' },
                    { text: '❌ Отменить', callback_data: 'admin_cancel_broadcast' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_back' }]
            ]
        }
    };
}

export function getOfferDeactivateKeyboard(offers: Array<{ id: number; title: string }>) {
    const buttons = offers.map(offer => ([{
        text: offer.title,
        callback_data: `admin_deactivate_offer_${offer.id}`
    }]));
    
    buttons.push([{ text: '◀️ Назад', callback_data: 'admin_back' }]);
    
    return {
        reply_markup: {
            inline_keyboard: buttons
        }
    };
}

export function getBackupRestoreKeyboard(backups: Array<{ id: number; filename: string }>) {
    const buttons = backups.map(backup => ([{
        text: backup.filename,
        callback_data: `admin_restore_backup_${backup.id}`
    }]));
    
    buttons.push([{ text: '◀️ Назад', callback_data: 'admin_back' }]);
    
    return {
        reply_markup: {
            inline_keyboard: buttons
        }
    };
}

export function getAdminConfirmationKeyboard(action: string) {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Подтвердить', callback_data: `admin_confirm_${action}` },
                    { text: '❌ Отменить', callback_data: 'admin_back' }
                ]
            ]
        }
    };
}

export function getBackupSettingsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🕒 Расписание', callback_data: 'admin_backup_schedule' },
                    { text: '📁 Путь сохранения', callback_data: 'admin_backup_path' }
                ],
                [
                    { text: '🔄 Автоочистка', callback_data: 'admin_backup_cleanup' },
                    { text: '📧 Уведомления', callback_data: 'admin_backup_notifications' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_backups' }]
            ]
        }
    };
}

export function getAdminStatsGraphsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Пользователи', callback_data: 'admin_graph_users' },
                    { text: '💰 Платежи', callback_data: 'admin_graph_payments' }
                ],
                [
                    { text: '📸 Обработка фото', callback_data: 'admin_graph_photos' },
                    { text: '🎉 Акции', callback_data: 'admin_graph_offers' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_stats' }]
            ]
        }
    };
}

export function getAdminBroadcastSelectKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💳 С балансом > 0', callback_data: 'admin_broadcast_with_credits' },
                    { text: '🆕 Новые пользователи', callback_data: 'admin_broadcast_new_users' }
                ],
                [
                    { text: '💰 Совершившие платежи', callback_data: 'admin_broadcast_paid_users' },
                    { text: '📸 Активные', callback_data: 'admin_broadcast_active_users' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_broadcast' }]
            ]
        }
    };
}

export function getAdminExportStatsKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Excel', callback_data: 'admin_export_excel' },
                    { text: '📝 CSV', callback_data: 'admin_export_csv' }
                ],
                [
                    { text: '📋 JSON', callback_data: 'admin_export_json' },
                    { text: '📄 PDF', callback_data: 'admin_export_pdf' }
                ],
                [{ text: '◀️ Назад', callback_data: 'admin_stats' }]
            ]
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