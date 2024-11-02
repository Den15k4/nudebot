import { Context } from 'telegraf';
import { Message } from 'telegraf/typings/core/types/typegram';
import { db } from '../services/database';
import { imageProcessor } from '../services/imageProcess';
import { sendMessage } from './messages';
import { getMainKeyboard } from './keyboard';
import { PATHS } from '../config/environment';
import { MESSAGES } from './messages';

export async function processPhotoMessage(ctx: Context): Promise<void> {
    if (!('message' in ctx.update) || !ctx.update.message || !('photo' in ctx.update.message)) {
        return;
    }

    const msg = ctx.update.message;
    if (!ctx.from || !ctx.chat) {
        return;
    }

    const userId = ctx.from.id;
    let processingMsg;
    
    try {
        const credits = await db.checkCredits(userId);

        if (credits <= 0) {
            await sendMessage(
                ctx,
                PATHS.ASSETS.PAYMENT,
                'У вас закончились кредиты. Используйте команду /buy для покупки дополнительных кредитов.',
                getMainKeyboard()
            );
            return;
        }

        await sendMessage(
            ctx,
            PATHS.ASSETS.PAYMENT_PROCESS,
            '⚠️ Важные правила:\n\n' +
            '1. Изображение должно содержать только людей старше 18 лет\n' +
            '2. Убедитесь, что на фото чётко видно лицо\n' +
            '3. Изображение должно быть хорошего качества\n\n' +
            '⏳ Начинаю обработку...'
        );

        processingMsg = await ctx.reply('⏳ Обрабатываю изображение, пожалуйста, подождите...');

        const photo = msg.photo[msg.photo.length - 1];
        const imageBuffer = await imageProcessor.downloadTelegramFile(photo.file_id, ctx.telegram);

        try {
            const result = await imageProcessor.processImage(imageBuffer, userId);

            if (result.idGen) {
                await db.updateUserCredits(userId, -1);
                await sendMessage(
                    ctx,
                    PATHS.ASSETS.PAYMENT_PROCESS,
                    '✅ Изображение принято на обработку:\n' +
                    `🕒 Время в очереди: ${result.queueTime} сек\n` +
                    `📊 Позиция в очереди: ${result.queueNum}\n` +
                    `🔄 ID задачи: ${result.idGen}\n\n` +
                    'Результат будет отправлен, когда обработка завершится.',
                    getMainKeyboard()
                );
            }

            if (processingMsg?.message_id) {
                await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
            }
        } catch (error) {
            throw error;
        }

    } catch (error) {
        let errorMessage = '❌ Произошла ошибка при обработке изображения.';
        
        if (error instanceof Error) {
            console.error('Ошибка при обработке изображения:', error.message);
            
            if (error.message === 'AGE_RESTRICTION') {
                errorMessage = MESSAGES.ERRORS.AGE_RESTRICTION;
            } else if (error.message === 'INSUFFICIENT_BALANCE') {
                errorMessage = MESSAGES.ERRORS.INSUFFICIENT_BALANCE;
            } else {
                errorMessage += `\n${error.message}`;
            }
        }

        await sendMessage(
            ctx,
            PATHS.ASSETS.PAYMENT,
            errorMessage,
            getMainKeyboard()
        );

        if (processingMsg?.message_id) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        }
    }
}