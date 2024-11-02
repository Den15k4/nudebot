import { Context } from 'telegraf';
import { ParseMode } from 'telegraf/typings/core/types/typegram';
import { logger } from '../index';

export interface MessageOptions {
    reply_markup?: any;
    parse_mode?: ParseMode;
    disable_web_page_preview?: boolean;
    disable_notification?: boolean;
    protect_content?: boolean;
    reply_to_message_id?: number;
    [key: string]: any;
}

// Кэш последних сообщений
const lastMessageIds = new Map<number, number>();
const MESSAGE_CACHE_LIMIT = 1000;

// Очистка старых сообщений из кэша
function cleanupMessageCache() {
    if (lastMessageIds.size > MESSAGE_CACHE_LIMIT) {
        const entries = Array.from(lastMessageIds.entries());
        entries.slice(0, entries.length - MESSAGE_CACHE_LIMIT).forEach(([key]) => {
            lastMessageIds.delete(key);
        });
    }
}

// Основная функция отправки сообщений
export async function sendMessage(
    ctx: Context,
    text: string,
    options: MessageOptions = {}
): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) {
        logger.error('Попытка отправить сообщение без userId');
        return;
    }

    try {
        const defaultOptions: MessageOptions = {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options
        };

        // Удаление предыдущего сообщения
        const lastMessageId = lastMessageIds.get(userId);
        if (lastMessageId) {
            try {
                await ctx.telegram.deleteMessage(userId, lastMessageId).catch(() => {});
            } catch (error) {
                logger.warn('Ошибка при удалении предыдущего сообщения:', {
                    userId,
                    messageId: lastMessageId,
                    error
                });
            }
        }

        // Отправка нового сообщения
        const sentMessage = await ctx.reply(text, defaultOptions);
        
        if (sentMessage?.message_id) {
            lastMessageIds.set(userId, sentMessage.message_id);
            cleanupMessageCache();
        }

        logger.debug('Сообщение отправлено:', {
            userId,
            messageId: sentMessage?.message_id,
            text: text.substring(0, 100) // Логируем только начало сообщения
        });
    } catch (error) {
        logger.error('Ошибка при отправке сообщения:', {
            userId,
            error,
            text: text.substring(0, 100)
        });

        // Пытаемся отправить сообщение без специальных опций
        try {
            await ctx.reply(text, {
                parse_mode: 'HTML' as ParseMode
            });
        } catch (retryError) {
            logger.error('Критическая ошибка при повторной отправке сообщения:', retryError);
        }
    }
}

// Шаблоны сообщений
export const MESSAGES = {
    WELCOME: (isAccepted: boolean) => {
        if (isAccepted) {
            return '🤖 С возвращением!\n\n' +
                'Для обработки изображений необходимы кредиты:\n' +
                '1 кредит = 1 обработка изображения\n\n' +
                'Используйте кнопки меню для навигации:';
        }
        return '👋 Добро пожаловать!\n\n' +
            '🤖 Я бот для обработки изображений с использованием нейросети.\n\n' +
            '⚠️ Перед началом работы, пожалуйста:\n' +
            '1. Ознакомьтесь с правилами использования бота\n' +
            '2. Подтвердите своё согласие с правилами\n\n' +
            '❗️ Важно: использование бота возможно только после принятия правил.';
    },

    RULES: '📜 <b>Правила использования бота:</b>\n\n' +
        '1. Бот предназначен только для лиц старше 18 лет\n' +
        '2. Запрещено использование изображений несовершеннолетних\n' +
        '3. Запрещено использование изображений, содержащих насилие\n' +
        '4. Пользователь несет ответственность за загружаемый контент\n' +
        '5. Администрация бота не хранит обработанные изображения\n\n' +
        '❗️ Нарушение правил приведет к блокировке без возврата средств',

        RULES_ACCEPTED: '✅ Спасибо за принятие правил!\n\n' +
        'Теперь вы можете использовать бота.\n\n' +
        'Для начала работы необходимо приобрести кредиты:\n' +
        '1 кредит = 1 обработка изображения\n\n' +
        'Используйте кнопки меню для навигации:',

    HELP: '❓ <b>Помощь:</b>\n\n' +
        'Доступные команды:\n' +
        '/start - Перезапустить бота\n' +
        '/buy - Купить кредиты\n' +
        '/credits - Проверить баланс\n' +
        '/referrals - Реферальная программа\n\n' +
        'При возникновении проблем обращайтесь в поддержку: @support',

    ERRORS: {
        AGE_RESTRICTION: '🔞 Обработка запрещена:\n\n' +
            'Изображение не прошло проверку возрастных ограничений. ' +
            'Пожалуйста, убедитесь, что на фото только люди старше 18 лет.',
        
        INSUFFICIENT_CREDITS: '⚠️ Недостаточно кредитов\n\n' +
            'Для обработки изображений необходимы кредиты.\n' +
            'Используйте команду /buy для покупки кредитов.',

        FILE_TOO_LARGE: '⚠️ Файл слишком большой\n\n' +
            'Максимальный размер файла: 10MB.\n' +
            'Пожалуйста, уменьшите размер изображения.',

        INVALID_FORMAT: '⚠️ Неподдерживаемый формат\n\n' +
            'Поддерживаются форматы: JPEG, PNG, WebP.\n' +
            'Пожалуйста, конвертируйте изображение в поддерживаемый формат.',

        API_ERROR: (error: string) => 
            '❌ Ошибка при обработке:\n\n' +
            `${error}\n\n` +
            'Пожалуйста, попробуйте позже или обратитесь в поддержку.',

        PAYMENT_ERROR: (error: string) =>
            '❌ Ошибка при создании платежа:\n\n' +
            `${error}\n\n` +
            'Пожалуйста, попробуйте другой способ оплаты или обратитесь в поддержку.',

        GENERAL_ERROR: '❌ Произошла ошибка\n\n' +
            'Пожалуйста, попробуйте позже или обратитесь в поддержку.',
    },

    PAYMENTS: {
        SUCCESS: (amount: number, currency: string, credits: number) =>
            '✅ Оплата успешно получена!\n\n' +
            `Сумма: ${amount} ${currency}\n` +
            `Начислено кредитов: ${credits}\n\n` +
            'Приятного использования!',

        PENDING: '⏳ Ожидание подтверждения оплаты...\n\n' +
            'Кредиты будут начислены автоматически после подтверждения платежа.',

        FAILED: '❌ Оплата не прошла\n\n' +
            'Пожалуйста, попробуйте другой способ оплаты или обратитесь в поддержку.',

        CHECKOUT: (package_: { credits: number, price: number, currency: string }) =>
            '💳 Оформление заказа:\n\n' +
            `Количество кредитов: ${package_.credits}\n` +
            `Сумма к оплате: ${package_.price} ${package_.currency}\n\n` +
            'Для оплаты нажмите кнопку ниже:',
    },

    REFERRAL: {
        INVITE: (userId: number) => 
            '👥 <b>Реферальная программа:</b>\n\n' +
            '1. Пригласите друзей по вашей реферальной ссылке\n' +
            '2. Получайте 50% от каждого их платежа\n' +
            '3. Бонусы начисляются автоматически\n\n' +
            '🔗 Ваша реферальная ссылка:\n' +
            `https://t.me/${process.env.BOT_USERNAME}?start=${userId}`,

        STATS: (count: number, earnings: number) =>
            '📊 <b>Ваша реферальная статистика:</b>\n\n' +
            `👥 Приглашено пользователей: ${count}\n` +
            `💰 Заработано: ${earnings}₽`,

        EARNINGS: (earnings: number, pendingEarnings: number) =>
            '💰 <b>Ваш реферальный заработок:</b>\n\n' +
            `Всего заработано: ${earnings}₽\n` +
            `Ожидает выплаты: ${pendingEarnings}₽\n\n` +
            'Выплаты производятся автоматически при достижении 1000₽',
    },

    PROCESSING: {
        START: '⚙️ Начинаю обработку изображения...',

        QUEUE_INFO: (position: number, estimatedTime: number) =>
            '⏳ Изображение в очереди на обработку:\n\n' +
            `Позиция в очереди: ${position}\n` +
            `Примерное время ожидания: ${estimatedTime} сек`,

        SUCCESS: '✨ Обработка завершена!\n\n' +
            'Используйте кнопки ниже для следующего действия:',

        REQUIREMENTS: '📸 Отправьте фотографию для обработки.\n\n' +
            '⚠️ Требования к фото:\n' +
            '- Хорошее качество\n' +
            '- Четкое изображение лица\n' +
            '- Размер до 10MB\n' +
            '- Формат: JPEG, PNG, WebP\n' +
            '- Только совершеннолетние',
    },

    ADMIN: {
        STATS: (stats: any) =>
            '📊 <b>Статистика бота:</b>\n\n' +
            `👥 Пользователей всего: ${stats.users.total}\n` +
            `👤 Активных за 24ч: ${stats.users.active_24h}\n` +
            `💳 Платящих: ${stats.users.paid}\n\n` +
            `📸 Обработано фото: ${stats.photos.total_processed}\n` +
            `✅ Успешных: ${stats.photos.successful}\n` +
            `❌ Ошибок: ${stats.photos.failed}\n\n` +
            `💰 Общая выручка: ${stats.payments.total_amount}₽`,

        BROADCAST: {
            START: '📨 Введите текст рассылки:',
            CONFIRM: (text: string, userCount: number) =>
                '📨 Подтверждение рассылки:\n\n' +
                `Текст:\n${text}\n\n` +
                `Получателей: ${userCount}\n\n` +
                'Подтвердите отправку:',
            SUCCESS: (sent: number, failed: number) =>
                '✅ Рассылка завершена:\n\n' +
                `Отправлено: ${sent}\n` +
                `Ошибок: ${failed}`,
        },
    }
} as const;

// Форматирование больших чисел
export function formatNumber(num: number): string {
    return new Intl.NumberFormat('ru-RU').format(num);
}

// Форматирование времени
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} сек`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`;
    return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

// Обработка HTML-тегов для безопасного отображения
export function safeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Форматирование ошибок для пользователя
export function formatError(error: unknown): string {
    if (error instanceof Error) {
        // Проверяем известные типы ошибок
        if (error.message.includes('AGE_RESTRICTION')) {
            return MESSAGES.ERRORS.AGE_RESTRICTION;
        }
        if (error.message.includes('INSUFFICIENT_CREDITS')) {
            return MESSAGES.ERRORS.INSUFFICIENT_CREDITS;
        }
        if (error.message.includes('too large')) {
            return MESSAGES.ERRORS.FILE_TOO_LARGE;
        }
        if (error.message.includes('format')) {
            return MESSAGES.ERRORS.INVALID_FORMAT;
        }
        return MESSAGES.ERRORS.API_ERROR(error.message);
    }
    return MESSAGES.ERRORS.GENERAL_ERROR;
}