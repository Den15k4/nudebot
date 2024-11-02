import { Context } from 'telegraf';
import { ParseMode } from 'telegraf/typings/core/types/typegram';

export interface MessageOptions {
    reply_markup?: any;
    parse_mode?: ParseMode;
    [key: string]: any;
}

const lastMessageIds = new Map<number, number>();

export async function sendMessage(
    ctx: Context,
    text: string,
    options?: MessageOptions
) {
    try {
        const userId = ctx.from?.id;
        if (userId) {
            const lastMessageId = lastMessageIds.get(userId);
            if (lastMessageId) {
                await ctx.telegram.deleteMessage(userId, lastMessageId).catch(() => {});
            }
        }

        const sentMessage = await ctx.reply(text, {
            parse_mode: 'HTML' as ParseMode,
            ...(options || {})
        });

        if (userId && sentMessage) {
            lastMessageIds.set(userId, sentMessage.message_id);
        }
    } catch (error) {
        console.error('Ошибка при отправке сообщения:', error);
        await ctx.reply(text, {
            parse_mode: 'HTML' as ParseMode,
            ...options
        });
    }
}

export const MESSAGES = {
    WELCOME: (isAccepted: boolean) => isAccepted ? 
        '🤖 С возвращением!\n\n' +
        'Для обработки изображений необходимы кредиты:\n' +
        '1 кредит = 1 обработка изображения\n\n' +
        'Используйте кнопки меню для навигации:'
        :
        '👋 Добро пожаловать!\n\n' +
        '🤖 Я бот для обработки изображений с использованием нейросети.\n\n' +
        '⚠️ Перед началом работы, пожалуйста:\n' +
        '1. Ознакомьтесь с правилами использования бота\n' +
        '2. Подтвердите своё согласие с правилами\n\n' +
        '❗️ Важно: использование бота возможно только после принятия правил.',


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
            'Используйте команду /buy для покупки кредитов.'
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
            `💰 Заработано: ${earnings}₽`
    }
} as const;