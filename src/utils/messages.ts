import { Context } from 'telegraf';
import { ParseMode } from 'telegraf/typings/core/types/typegram';
import { formatNumber, formatDuration } from '../utils/formatters';
import { logger } from '../utils/logger';

export interface MessageOptions {
    reply_markup?: any;
    parse_mode?: ParseMode;
    disable_web_page_preview?: boolean;
    disable_notification?: boolean;
    protect_content?: boolean;
    reply_to_message_id?: number;
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
            text: text.substring(0, 100)
        });
    } catch (error) {
        logger.error('Ошибка при отправке сообщения:', {
            userId,
            error,
            text: text.substring(0, 100)
        });

        // Пытаемся отправить сообщение без специальных опций
        try {
            await ctx.reply(text, { parse_mode: 'HTML' });
        } catch (retryError) {
            logger.error('Критическая ошибка при повторной отправке сообщения:', retryError);
        }
    }
}

// Шаблоны сообщений
export const MESSAGES = {
    WELCOME: (isAccepted: boolean) => {
        if (isAccepted) {
            return '👋 С возвращением!\n\n' +
                '📸 Отправьте фото для обработки или воспользуйтесь меню.\n\n' +
                '💡 1 кредит = 1 обработка изображения';
        }
        return '👋 Добро пожаловать!\n\n' +
            '🤖 Я бот для обработки изображений.\n\n' +
            '⚠️ Перед началом работы ознакомьтесь с правилами:\n' +
            '1️⃣ Бот предназначен для лиц старше 18 лет\n' +
            '2️⃣ Запрещено использование изображений несовершеннолетних\n' +
            '3️⃣ Запрещена обработка изображений с насилием\n\n' +
            '❗️ Чтобы начать, примите правила использования.';
    },

    RULES: '📜 <b>Правила использования:</b>\n\n' +
        '1. Бот предназначен только для лиц старше 18 лет\n' +
        '2. Запрещено использование изображений несовершеннолетних\n' +
        '3. Запрещена обработка изображений с насилием\n' +
        '4. Пользователь несет ответственность за загружаемый контент\n' +
        '5. Администрация не хранит обработанные изображения\n\n' +
        '❗️ Нарушение правил приведет к блокировке без возврата средств',

    RULES_ACCEPTED: '✅ Спасибо за принятие правил!\n\n' +
        '🎁 Вам начислен 1 бесплатный кредит\n\n' +
        '📸 Отправьте фото для обработки или используйте меню\n' +
        '💡 1 кредит = 1 обработка изображения',

    HELP: '❓ <b>Помощь:</b>\n\n' +
        '📝 Команды:\n' +
        '/start - Перезапуск бота\n' +
        '/buy - Купить кредиты\n' +
        '/credits - Проверить баланс\n' +
        '/referrals - Реферальная программа\n\n' +
        '💡 Как пользоваться:\n' +
        '1. Отправьте фото для обработки\n' +
        '2. Дождитесь результата\n' +
        '3. Получите обработанное изображение\n\n' +
        '⚠️ При проблемах обращайтесь в поддержку: @support',

    ERRORS: {
        AGE_RESTRICTION: '🔞 Обработка запрещена:\n\n' +
            'На изображении обнаружен человек младше 18 лет.\n' +
            'Обработка таких изображений запрещена.',
        
        INSUFFICIENT_CREDITS: '⚠️ Недостаточно кредитов\n\n' +
            'Для обработки изображений необходимы кредиты.\n' +
            'Используйте команду /buy для покупки.',

        FILE_TOO_LARGE: '⚠️ Файл слишком большой\n\n' +
            'Максимальный размер файла: 10MB.\n' +
            'Пожалуйста, уменьшите размер изображения.',

        INVALID_FORMAT: '⚠️ Неподдерживаемый формат\n\n' +
            'Поддерживаются форматы: JPEG, PNG, WebP.\n' +
            'Пожалуйста, конвертируйте изображение.',

        API_ERROR: (error: string) => 
            '❌ Ошибка при обработке:\n\n' +
            `${error}\n\n` +
            'Попробуйте позже или обратитесь в поддержку.',

        PAYMENT_ERROR: (error: string) =>
            '❌ Ошибка при оплате:\n\n' +
            `${error}\n\n` +
            'Попробуйте другой способ оплаты или обратитесь в поддержку.',

        GENERAL_ERROR: '❌ Произошла ошибка\n\n' +
            'Пожалуйста, попробуйте позже или обратитесь в поддержку.'
    },

    PAYMENTS: {
        SUCCESS: (amount: number, currency: string, credits: number) =>
            '✅ Оплата успешно получена!\n\n' +
            `Сумма: ${amount} ${currency}\n` +
            `Начислено кредитов: ${credits}\n\n` +
            'Приятного использования!',

        PENDING: '⏳ Ожидание подтверждения оплаты...\n\n' +
            'Кредиты будут начислены автоматически.',

        FAILED: '❌ Оплата не прошла\n\n' +
            'Попробуйте другой способ оплаты или обратитесь в поддержку.',

        CHECKOUT: (package_: { credits: number, price: number, currency: string }) =>
            '💳 Оформление заказа:\n\n' +
            `Количество кредитов: ${package_.credits}\n` +
            `Сумма к оплате: ${package_.price} ${package_.currency}\n\n` +
            'Для оплаты нажмите кнопку ниже:',
    },

    REFERRAL: {
        INVITE: (userId: number) => 
            '👥 <b>Реферальная программа:</b>\n\n' +
            '1. Пригласите друзей по вашей ссылке\n' +
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
            'Выплаты от 100₽',

        WITHDRAWAL: {
            REQUEST: '💳 Введите реквизиты для вывода средств:\n' +
                '/withdraw <номер карты или USDT-адрес>',

            SUCCESS: '✅ Заявка на вывод создана!\n' +
                'Средства поступят в течение 24 часов.',

            INSUFFICIENT_FUNDS: '⚠️ Недостаточно средств\n' +
                'Минимальная сумма для вывода: 100₽',

            ERROR: '❌ Ошибка при создании заявки\n' +
                'Попробуйте позже или обратитесь в поддержку.'
        }
    },

    PROCESSING: {
        START: '⚙️ Начинаю обработку изображения...',

        QUEUE_INFO: (position: number, estimatedTime: number) =>
            '⏳ Изображение в очереди:\n\n' +
            `Позиция: ${position}\n` +
            `Примерное время: ${formatDuration(estimatedTime)}`,

        SUCCESS: '✨ Обработка завершена!\n\n' +
            'Используйте кнопки ниже для следующего действия:',

        REQUIREMENTS: '📸 Отправьте фото для обработки.\n\n' +
            '⚠️ Требования:\n' +
            '- Хорошее качество\n' +
            '- Четкое изображение лица\n' +
            '- Размер до 10MB\n' +
            '- Формат: JPEG, PNG, WebP\n' +
            '- Только совершеннолетние'
    },

    ADMIN: {
        STATS: (stats: any) =>
            '📊 <b>Статистика бота:</b>\n\n' +
            `👥 Пользователей всего: ${formatNumber(stats.users.total)}\n` +
            `👤 Активных за 24ч: ${formatNumber(stats.users.active_24h)}\n` +
            `💳 Платящих: ${formatNumber(stats.users.paid)}\n\n` +
            `📸 Обработано фото: ${formatNumber(stats.photos.total_processed)}\n` +
            `✅ Успешных: ${formatNumber(stats.photos.successful)}\n` +
            `❌ Ошибок: ${formatNumber(stats.photos.failed)}\n\n` +
            `💰 Общая выручка: ${formatNumber(stats.payments.total_amount)}₽`,

        BROADCAST: {
            START: '📨 Введите текст рассылки:',
            CONFIRM: (text: string, userCount: number) =>
                '📨 Подтверждение рассылки:\n\n' +
                `Текст:\n${text}\n\n` +
                `Получателей: ${formatNumber(userCount)}`,
            SUCCESS: (sent: number, failed: number) =>
                '✅ Рассылка завершена:\n\n' +
                `Отправлено: ${formatNumber(sent)}\n` +
                `Ошибок: ${formatNumber(failed)}`
        }
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

// Безопасный HTML
export function safeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}