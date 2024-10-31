import { Request, Response } from 'express';
import { db } from '../services/database';
import { broadcastService } from '../services/broadcast';
import { paymentService } from '../services/payment';
import { bot } from '../index';
import { PATHS } from '../config/environment';
import { getMainKeyboard } from '../utils/keyboard';

export async function handleClothoffWebhook(req: Request, res: Response) {
    try {
        console.log('Получен webhook от Clothoff:', {
            body: req.body,
            files: req.files,
            headers: req.headers,
            query: req.query
        });

        const body = req.body;
        const files = req.files as Express.Multer.File[] || [];

        // Если получена ошибка
        if (body.status === '500' || body.img_message || body.img_message_2) {
            const user = await db.getUserByPendingTask(body.id_gen);
            if (user) {
                let errorMessage = '❌ Не удалось обработать изображение:\n\n';
                
                if (body.img_message?.includes('Age is too young') || 
                    body.img_message_2?.includes('Age is too young')) {
                    errorMessage += '🔞 На изображении обнаружен человек младше 18 лет.\n' +
                                  'Обработка таких изображений запрещена.';
                } else {
                    errorMessage += body.img_message || body.img_message_2 || 'Неизвестная ошибка';
                }

                try {
                    await bot.telegram.sendMessage(
                        user.user_id,
                        errorMessage,
                        { parse_mode: 'HTML' }
                    );
                    await db.updateUserCredits(user.user_id, 1); // Возвращаем кредит
                    await db.setUserPendingTask(user.user_id, null);
                } catch (error) {
                    console.error('Ошибка при обработке ошибки webhook:', error);
                }
            }
            return res.json({ success: true });
        }

        // Обработка успешного результата
        if (body.result || files.length > 0) {
            console.log('Получен результат обработки:', {
                hasResult: !!body.result,
                filesCount: files.length,
                idGen: body.id_gen
            });

            const user = await db.getUserByPendingTask(body.id_gen);
            if (user) {
                let imageBuffer: Buffer | undefined;
                if (body.result) {
                    imageBuffer = Buffer.from(body.result, 'base64');
                } else if (files.length > 0) {
                    imageBuffer = files[0].buffer;
                }

                if (imageBuffer) {
                    try {
                        await bot.telegram.sendPhoto(
                            user.user_id,
                            { source: imageBuffer },
                            { 
                                caption: '✨ Обработка изображения завершена!',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '📸 Обработать ещё', callback_data: 'action_process_photo' }],
                                        [{ text: '◀️ В главное меню', callback_data: 'action_back' }]
                                    ]
                                }
                            }
                        );
                    } catch (error) {
                        console.error('Ошибка при отправке результата:', error);
                        await bot.telegram.sendMessage(
                            user.user_id,
                            '❌ Произошла ошибка при отправке результата обработки.'
                        );
                    }
                } else {
                    console.error('Не удалось получить изображение из результата');
                    await bot.telegram.sendMessage(
                        user.user_id,
                        '❌ Произошла ошибка при получении результата обработки.'
                    );
                }

                await db.setUserPendingTask(user.user_id, null);
            } else {
                console.error('Пользователь не найден для id_gen:', body.id_gen);
            }
        } else {
            console.log('Не найдено результата в webhook данных');
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Ошибка обработки webhook:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

export async function handleRukassaWebhook(req: Request, res: Response) {
    try {
        console.log('Получен webhook от Rukassa:', req.body);
        await paymentService.handleWebhook(req.body);
        return res.json({ success: true });
    } catch (error) {
        console.error('Ошибка обработки webhook Rukassa:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

export function handleHealth(_req: Request, res: Response) {
    return res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        scheduledBroadcasts: broadcastService.getScheduledBroadcastsCount()
    });
}

export function handlePaymentSuccess(_req: Request, res: Response) {
    return res.send(`
        <html>
            <head>
                <title>Оплата успешна</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial, sans-serif;">
                <div style="text-align: center; padding: 20px;">
                    <h1 style="color: #4CAF50;">✅ Оплата успешно завершена!</h1>
                    <p>Вернитесь в Telegram бот для проверки баланса.</p>
                </div>
            </body>
        </html>
    `);
}

export function handlePaymentFail(_req: Request, res: Response) {
    return res.send(`
        <html>
            <head>
                <title>Ошибка оплаты</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
            </head>
            <body style="display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: Arial, sans-serif;">
                <div style="text-align: center; padding: 20px;">
                    <h1 style="color: #f44336;">❌ Ошибка оплаты</h1>
                    <p>Вернитесь в Telegram бот и попробуйте снова.</p>
                </div>
            </body>
        </html>
    `);
}