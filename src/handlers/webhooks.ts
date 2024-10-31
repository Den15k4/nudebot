import { Request, Response } from 'express';
import { db } from '../services/database';
import { broadcastService } from '../services/broadcast';
import { paymentService } from '../services/payment';
import { bot } from '../index';
import { PATHS } from '../config/environment';
import { getMainKeyboard } from '../utils/keyboard';

export async function handleClothoffWebhook(req: Request, res: Response): Promise<void> {
    try {
        console.log('Получен webhook от Clothoff:', {
            body: req.body,
            files: req.files
        });

        const body = req.body;
        const files = req.files as Express.Multer.File[] || [];

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
                    await broadcastService.sendMessageWithImage(
                        user.user_id,
                        PATHS.ASSETS.PAYMENT,
                        errorMessage,
                        getMainKeyboard()
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
            const user = await db.getUserByPendingTask(body.id_gen);
            if (user) {
                let imageBuffer: Buffer | undefined;
                if (body.result) {
                    imageBuffer = Buffer.from(body.result, 'base64');
                } else if (files.length > 0) {
                    imageBuffer = files[0].buffer;
                }

                if (imageBuffer) {
                    await bot.telegram.sendPhoto(user.user_id, { source: imageBuffer });
                    await broadcastService.sendMessageWithImage(
                        user.user_id,
                        PATHS.ASSETS.PAYMENT_PROCESS,
                        '✨ Обработка изображения завершена!',
                        getMainKeyboard()
                    );
                }

                await db.setUserPendingTask(user.user_id, null);
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка обработки webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

export async function handleRukassaWebhook(req: Request, res: Response): Promise<void> {
    try {
        console.log('Получен webhook от Rukassa:', req.body);
        await paymentService.handleWebhook(req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка обработки webhook Rukassa:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}

export function handleHealth(req: Request, res: Response): void {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        scheduledBroadcasts: broadcastService.getScheduledBroadcastsCount()
    });
}

export function handlePaymentSuccess(req: Request, res: Response): void {
    res.send(`
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

export function handlePaymentFail(req: Request, res: Response): void {
    res.send(`
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