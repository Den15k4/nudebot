import { Request, Response } from 'express';
import { db } from '../services/database';
import { paymentService } from '../services/payment';
import { bot } from '../index';

export async function handleClothoffWebhook(req: Request, res: Response) {
    try {
        console.log('Получен webhook от Clothoff:', {
            body: req.body,
            files: req.files
        });

        const body = req.body;
        const files = req.files as Express.Multer.File[] || [];

        // Обработка ошибки
        if (body.status === '500' || body.img_message || body.img_message_2) {
            const user = await db.getUserByPendingTask(body.id_gen);
            if (user) {
                let errorMessage = '❌ Не удалось обработать изображение:\n\n';
                
                if (body.img_message?.includes('Age is too young') || 
                    body.img_message_2?.includes('Age is too young')) {
                    errorMessage = '🔞 На изображении обнаружен человек младше 18 лет.\n' +
                                 'Обработка таких изображений запрещена.';
                } else {
                    errorMessage += body.img_message || body.img_message_2 || 'Неизвестная ошибка';
                }

                await bot.telegram.sendMessage(user.user_id, errorMessage);
                await db.updateUserCredits(user.user_id, 1); // Возврат кредита
                await db.setUserPendingTask(user.user_id, null);
                await db.updatePhotoProcessingStats(user.user_id, false, errorMessage);
            }
            return res.json({ success: true });
        }

        // Обработка успешного результата
        if (body.result || files.length > 0) {
            const user = await db.getUserByPendingTask(body.id_gen);
            if (user) {
                let imageBuffer: Buffer | undefined;
                if (body.result) {
                    imageBuffer = Buffer.from(body.result, 'base64');
                } else if (files.length > 0) {
                    imageBuffer = files[0].buffer;
                }

                if (imageBuffer) {
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
                    await db.updatePhotoProcessingStats(user.user_id, true);
                }

                await db.setUserPendingTask(user.user_id, null);
            }
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
        timestamp: new Date().toISOString()
    });
}