import { Telegraf, Context } from 'telegraf';

export class ChannelRequestsHandler {
    private bot: Telegraf;
    private channelId: string;

    constructor(bot: Telegraf, channelId: string) {
        this.bot = bot;
        this.channelId = channelId;
    }

    public setupHandlers(): void {
        this.bot.on('chat_join_request', async (ctx) => {
            try {
                const request = ctx.chatJoinRequest;
                console.log('Получен запрос на вступление в канал:', {
                    userId: request.from.id,
                    channelId: request.chat.id,
                    timestamp: new Date().toISOString()
                });

                // Проверяем, что запрос именно в наш канал
                if (request.chat.id.toString() !== this.channelId) {
                    return;
                }

                // Одобряем заявку
                await this.bot.telegram.approveChatJoinRequest(
                    request.chat.id,
                    request.from.id
                );

                // Отправляем приветственное сообщение с кнопкой
                await this.bot.telegram.sendMessage(
                    request.from.id,
                    `👋 Спасибо за заявку в канал!\n\n` +
                    `🤖 Пока вы ждете одобрения, предлагаю ознакомиться с функционалом нашего бота.\n\n` +
                    `Нажмите кнопку ниже, чтобы начать:`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '🚀 Начать',
                                        callback_data: 'start' // Изменено с 'start' на 'start_processing'
                                    }
                                ]
                            ]
                        }
                    }
                );

                console.log('Заявка в канал обработана:', {
                    userId: request.from.id,
                    channelId: request.chat.id,
                    status: 'approved',
                    timestamp: new Date().toISOString()
                });

            } catch (error) {
                console.error('Ошибка при обработке заявки в канал:', error);
                
                // Пытаемся уведомить пользователя об ошибке
                if (ctx.chatJoinRequest?.from.id) {
                    try {
                        await this.bot.telegram.sendMessage(
                            ctx.chatJoinRequest.from.id,
                            '❌ Произошла ошибка при обработке вашей заявки. Пожалуйста, попробуйте позже или свяжитесь с администратором.'
                        );
                    } catch (sendError) {
                        console.error('Ошибка при отправке уведомления об ошибке:', sendError);
                    }
                }
            }
        });
    }
}