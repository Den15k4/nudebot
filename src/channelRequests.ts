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

                // Отправляем приветственное сообщение с кнопкой-ссылкой
                await this.bot.telegram.sendMessage(
                    request.from.id,
                    `🔎 Я могу раздеть фото любой девушки!\n\n` +
                    `💬 Жми /start`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '🚀 /start',
                                        url: 'https://t.me/photowombot?start=ref1941779857'
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