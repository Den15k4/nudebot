import { Telegraf } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import { ENV } from '../config/environment';
import { API_CONFIG, CURRENCY_RATES } from '../config/constants';
import { db } from './database';
import { SupportedCurrency, Currency, PaymentPackage } from '../types/interfaces';

export const SUPPORTED_CURRENCIES: Currency[] = [
    { 
        code: 'RUB', 
        symbol: '₽', 
        name: 'Visa/MC/MIR', 
        method: 'card',  // Изменено с CARD на card
        minAmount: 300
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Visa/MC [KZT]', 
        method: 'card_kzt', // Изменено с CARD_KZT на card_kzt
        minAmount: 32500
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Visa/MC [UZS]', 
        method: 'card_uzs', // Изменено с CARD_UZS на card_uzs
        minAmount: 86000
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Crypto', 
        method: 'crypta',  // Изменено с CRYPTA на crypta
        minAmount: 3
    },
    {
        code: 'RUB_SBP',
        symbol: '₽',
        name: 'СБП',
        method: 'sbp',    // Изменено с SBP на sbp
        minAmount: 300
    }
];

export class PaymentService {
    constructor(private bot: Telegraf) {}

    private generateSignature(data: Record<string, string>): string {
        const sortedKeys = Object.keys(data).sort();
        const signString = sortedKeys
            .map(key => `${key}:${data[key]}`)
            .join('|');
        
        return crypto
            .createHash('md5')
            .update(signString + ENV.RUKASSA_TOKEN)
            .digest('hex');
    }

    async createPayment(
        userId: number,
        packageId: number,
        currency: SupportedCurrency = 'RUB'
    ): Promise<string> {
        const package_ = CREDIT_PACKAGES.find(p => p.id === packageId);
        if (!package_) {
            throw new Error('Неверный ID пакета');
        }

        const curr = SUPPORTED_CURRENCIES.find(c => c.code === currency);
        if (!curr) {
            throw new Error('Неподдерживаемая валюта');
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        const amount = package_.prices[currency].toString();

        try {
            await db.createPayment(
                userId, 
                merchantOrderId, 
                parseFloat(amount), 
                package_.credits, 
                currency
            );

            const paymentData = {
                shop_id: ENV.SHOP_ID,
                amount: amount,
                currency: currency === 'CRYPTO' ? 'USDT' : currency,
                order_id: merchantOrderId,
                payment_method: curr.method,
                fields: JSON.stringify({
                    user_id: userId,
                    package_id: packageId,
                    credits: package_.credits
                }),
                webhook_url: `${ENV.WEBHOOK_URL}/rukassa/webhook`,
                success_url: `${ENV.WEBHOOK_URL}/payment/success`,
                fail_url: `${ENV.WEBHOOK_URL}/payment/fail`
            };

            // Генерируем подпись
            const signature = this.generateSignature(paymentData);
            paymentData['sign'] = signature;

            console.log('Отправляем запрос на создание платежа:', paymentData);

            const response = await axios.post(
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

            console.log('Ответ от Rukassa:', response.data);

            if (response.data.error) {
                throw new Error(response.data.message || response.data.error);
            }

            const paymentUrl = response.data.url || response.data.link;
            if (!paymentUrl) {
                throw new Error('Не удалось получить ссылку на оплату');
            }

            return paymentUrl;

        } catch (error) {
            await db.deletePayment(merchantOrderId);
            console.error('Ошибка при создании платежа:', error);
            throw error;
        }
    }

    async handleWebhook(data: any): Promise<void> {
        console.log('Получены данные вебхука:', data);

        try {
            // Проверяем подпись
            const receivedSign = data.sign;
            delete data.sign;
            
            const calculatedSign = this.generateSignature(data);
            
            if (receivedSign !== calculatedSign) {
                console.error('Неверная подпись вебхука');
                throw new Error('Invalid signature');
            }

            const payment = await db.getPaymentByMerchantId(data.merchant_order_id);
            if (!payment) {
                throw new Error('Платёж не найден');
            }

            await db.updatePaymentStatus(payment.id, data.status, data.order_id);

            if (data.status === 'paid') {
                await db.updateUserCredits(payment.user_id, payment.credits);
                await db.processReferralPayment(payment.id);
                
                const curr = SUPPORTED_CURRENCIES.find(c => c.code === payment.currency);
                await this.bot.telegram.sendMessage(
                    payment.user_id,
                    `✅ Оплата ${payment.amount} ${curr?.symbol || payment.currency} успешно получена!\n` +
                    `На ваш счет зачислено ${payment.credits} кредитов.`
                );
            }
        } catch (error) {
            console.error('Ошибка обработки webhook:', error);
            throw error;
        }
    }
}

export let paymentService: PaymentService;

export function initPaymentService(bot: Telegraf): void {
    paymentService = new PaymentService(bot);
}