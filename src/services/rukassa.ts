import { Telegraf } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import { ENV } from '../config/environment';
import { API_CONFIG, PAYMENT_METHODS } from '../config/constants';
import { logger } from '../utils/logger';
import { 
    RukassaPaymentRequest, 
    RukassaWebhookBody,
    PaymentResponse 
} from '../types/interfaces';
import { db } from './database';

// Функция для генерации подписи Rukassa
export function generateSignature(data: RukassaPaymentRequest): string {
    const signatureData = `${data.shop_id}:${data.amount}:${data.order_id}:${ENV.RUKASSA_TOKEN}`;
    return crypto.createHash('md5').update(signatureData).digest('hex');
}

// Функция проверки подписи вебхука
export function verifyWebhookSignature(data: RukassaWebhookBody): boolean {
    const signatureData = `${data.shop_id}:${data.amount}:${data.order_id}:${ENV.RUKASSA_TOKEN}`;
    const calculatedSignature = crypto
        .createHash('md5')
        .update(signatureData)
        .digest('hex');
    
    return calculatedSignature === data.sign;
}

// Класс для работы с Rukassa API
export class RukassaService {
    private readonly bot: Telegraf;
    private readonly MAX_RETRY_ATTEMPTS = 3;
    private readonly RETRY_DELAY = 2000;

    constructor(bot: Telegraf) {
        this.bot = bot;
    }

    private async retryOperation<T>(operation: () => Promise<T>, attempts = 0): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (attempts < this.MAX_RETRY_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, attempts)));
                return this.retryOperation(operation, attempts + 1);
            }
            throw error;
        }
    }

    async createPayment(
        userId: number,
        amount: number,
        credits: number,
        currency: string,
        method: string
    ): Promise<string> {
        try {
            const merchantOrderId = `${userId}_${Date.now()}`;
            
            const paymentData: RukassaPaymentRequest = {
                shop_id: ENV.SHOP_ID,
                token: ENV.RUKASSA_TOKEN,
                order_id: merchantOrderId,
                amount: amount.toString(),
                user_code: userId.toString(),
                method: PAYMENT_METHODS[method as keyof typeof PAYMENT_METHODS],
                currency_in: currency === 'CRYPTO' ? 'USDT' : currency,
                custom_fields: JSON.stringify({
                    credits,
                    user_id: userId
                }),
                webhook_url: `${ENV.WEBHOOK_URL}/rukassa/webhook`,
                success_url: ENV.RUKASSA_SUCCESS_URL,
                fail_url: ENV.RUKASSA_FAIL_URL,
                back_url: ENV.RUKASSA_BACK_URL
            };

            // Создаем запись о платеже в БД
            await db.createPayment(userId, merchantOrderId, amount, credits, currency);

            // Отправляем запрос в Rukassa
            const response = await this.retryOperation(async () => {
                return axios.post<PaymentResponse>(
                    API_CONFIG.RUKASSA_API_URL,
                    paymentData,
                    {
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        },
                        timeout: 10000
                    }
                );
            });

            if (response.data.error) {
                await db.deletePayment(merchantOrderId);
                throw new Error(response.data.message || response.data.error);
            }

            const paymentUrl = response.data.url || response.data.link;
            if (!paymentUrl) {
                await db.deletePayment(merchantOrderId);
                throw new Error('Не удалось получить ссылку на оплату');
            }

            logger.info('Создан платёж:', { userId, merchantOrderId, amount, credits });
            return paymentUrl;

        } catch (error) {
            logger.error('Ошибка при создании платежа:', error);
            throw error;
        }
    }

    async handleWebhook(data: RukassaWebhookBody): Promise<void> {
        try {
            // Проверяем подпись
            if (!verifyWebhookSignature(data)) {
                logger.error('Неверная подпись вебхука:', data);
                throw new Error('Invalid signature');
            }

            // Получаем платёж из БД
            const payment = await db.getPaymentByMerchantId(data.merchant_order_id);
            if (!payment) {
                logger.error('Платёж не найден:', data.merchant_order_id);
                throw new Error('Payment not found');
            }

            // Обновляем статус платежа
            await db.updatePaymentStatus(payment.id, data.payment_status, data.order_id);

            // Если платёж успешен
            if (data.payment_status === 'paid') {
                try {
                    // Начисляем кредиты
                    await db.updateUserCredits(payment.user_id, payment.credits);

                    // Обрабатываем реферальное начисление
                    await db.processReferralPayment(payment.id);

                    // Отправляем уведомление пользователю
                    await this.bot.telegram.sendMessage(
                        payment.user_id,
                        `✅ Оплата успешно получена!\n` +
                        `💳 Сумма: ${payment.amount} ${payment.currency}\n` +
                        `🎁 Начислено кредитов: ${payment.credits}`
                    );

                    logger.info('Платёж успешно обработан:', {
                        userId: payment.user_id,
                        orderId: data.order_id,
                        amount: payment.amount
                    });
                } catch (error) {
                    logger.error('Ошибка при обработке успешного платежа:', error);
                    throw error;
                }
            }
        } catch (error) {
            logger.error('Ошибка при обработке вебхука:', error);
            throw error;
        }
    }
}

let rukassaService: RukassaService;

export function initRukassaService(bot: Telegraf): void {
    rukassaService = new RukassaService(bot);
    logger.info('Rukassa сервис инициализирован');
}

export function getRukassaService(): RukassaService {
    if (!rukassaService) {
        throw new Error('Rukassa service not initialized');
    }
    return rukassaService;
}