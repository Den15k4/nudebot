import { Request, Response } from 'express';
import crypto from 'crypto';
import { logger } from '../index';
import { db } from '../services/database';
import { paymentService } from '../services/payment';
import { bot } from '../index';
import { ENV } from '../config/environment';

interface RukassaWebhookBody {
    shop_id: string;
    amount: string;
    order_id: string;
    payment_status: string;
    payment_method: string;
    custom_fields: string;
    merchant_order_id: string;
    sign: string;
}

// Функция проверки подписи от Rukassa
function verifyRukassaSignature(data: RukassaWebhookBody): boolean {
    const signatureData = `${data.shop_id}:${data.amount}:${data.order_id}:${ENV.RUKASSA_TOKEN}`;
    const calculatedSignature = crypto
        .createHash('md5')
        .update(signatureData)
        .digest('hex');
    
    return calculatedSignature === data.sign;
}

// Обработчик вебхука от Clothoff API
export async function handleClothoffWebhook(req: Request, res: Response) {
    try {
        logger.info('Получен webhook от Clothoff:', {
            body: req.body,
            files: req.files
        });

        const body = req.body;
        const files = req.files as Express.Multer.File[] || [];

        // Проверка наличия id_gen
        if (!body.id_gen) {
            logger.error('Отсутствует id_gen в запросе');
            return res.status(400).json({ error: 'Missing id_gen' });
        }

        const user = await db.getUserByPendingTask(body.id_gen);
        if (!user) {
            logger.error('Пользователь не найден для задачи:', body.id_gen);
            return res.status(404).json({ error: 'User not found' });
        }

        // Обработка ошибок
        if (body.status === '500' || body.img_message || body.img_message_2) {
            let errorMessage = '❌ Не удалось обработать изображение:\n\n';
            let isAgeRestriction = false;

            if (body.img_message?.toLowerCase().includes('age is too young') || 
                body.img_message_2?.toLowerCase().includes('age is too young')) {
                errorMessage = '🔞 На изображении обнаружен человек младше 18 лет.\n' +
                             'Обработка таких изображений запрещена.';
                isAgeRestriction = true;
            } else {
                errorMessage += body.img_message || body.img_message_2 || 'Неизвестная ошибка';
            }

            try {
                await Promise.all([
                    bot.telegram.sendMessage(user.user_id, errorMessage),
                    db.updateUserCredits(user.user_id, 1), // Возврат кредита
                    db.setUserPendingTask(user.user_id, null),
                    db.updatePhotoProcessingStats(user.user_id, false, errorMessage)
                ]);

                logger.info('Ошибка обработана успешно:', {
                    userId: user.user_id,
                    isAgeRestriction,
                    errorMessage
                });
            } catch (error) {
                logger.error('Ошибка при обработке ошибки:', error);
            }

            return res.json({ success: true });
        }

        // Обработка успешного результата
        if (body.result || files.length > 0) {
            try {
                let imageBuffer: Buffer | undefined;
                
                if (body.result) {
                    imageBuffer = Buffer.from(body.result, 'base64');
                } else if (files.length > 0) {
                    imageBuffer = files[0].buffer;
                }

                if (imageBuffer) {
                    await Promise.all([
                        bot.telegram.sendPhoto(
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
                        ),
                        db.updatePhotoProcessingStats(user.user_id, true),
                        db.setUserPendingTask(user.user_id, null)
                    ]);

                    logger.info('Изображение успешно обработано:', {
                        userId: user.user_id,
                        taskId: body.id_gen
                    });
                } else {
                    throw new Error('Отсутствует изображение в ответе');
                }
            } catch (error) {
                logger.error('Ошибка при отправке результата:', error);
                throw error;
            }
        }

        return res.json({ success: true });
    } catch (error) {
        logger.error('Ошибка обработки webhook:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

// Обработчик вебхука от Rukassa
export async function handleRukassaWebhook(req: Request, res: Response) {
    try {
        const webhookData = req.body as RukassaWebhookBody;
        
        logger.info('Получен webhook от Rukassa:', webhookData);

        // Проверка подписи
        if (!verifyRukassaSignature(webhookData)) {
            logger.error('Неверная подпись webhook:', webhookData);
            return res.status(400).json({ error: 'Invalid signature' });
        }

        // Проверка наличия необходимых полей
        if (!webhookData.merchant_order_id || !webhookData.payment_status) {
            logger.error('Отсутствуют обязательные поля в webhook:', webhookData);
            return res.status(400).json({ error: 'Missing required fields' });
        }

        try {
            await paymentService.handleWebhook(webhookData);
            logger.info('Webhook успешно обработан:', {
                orderId: webhookData.merchant_order_id,
                status: webhookData.payment_status
            });
        } catch (error) {
            logger.error('Ошибка обработки webhook:', error);
            throw error;
        }

        return res.json({ success: true });
    } catch (error) {
        logger.error('Ошибка обработки webhook Rukassa:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

// Эндпоинт проверки здоровья сервиса
export async function handleHealth(_req: Request, res: Response) {
    try {
        // Проверка подключения к базе данных
        await db.pool.query('SELECT 1');
        
        return res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage()
        });
    } catch (error) {
        logger.error('Ошибка в health check:', error);
        return res.status(500).json({ 
            status: 'error',
            timestamp: new Date().toISOString(),
            error: 'Database connection failed'
        });
    }
}