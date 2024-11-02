import { Telegraf } from 'telegraf';
import axios from 'axios';
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
        method: 'card_kzt',  // Изменено с CARD_KZT на card_kzt
        minAmount: 32500
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Visa/MC [UZS]', 
        method: 'card_uzs',  // Изменено с CARD_UZS на card_uzs
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
        method: 'sbp',  // Изменено с SBP на sbp
        minAmount: 300
    }
];

export class PaymentService {
    constructor(private bot: Telegraf) {}

    private convertToRubles(amount: number, currency: SupportedCurrency): string {
        const rubles = Math.round(amount * CURRENCY_RATES[currency]);
        return rubles.toString();
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

        if (package_.prices[currency] === 0) {
            throw new Error(`Этот пакет недоступен для оплаты в ${currency}`);
        }

        if (package_.prices[currency] < curr.minAmount) {
            throw new Error(`Минимальная сумма для ${currency}: ${curr.minAmount} ${curr.symbol}`);
        }

        const merchantOrderId = `${userId}_${Date.now()}`;
        const amountInRubles = this.convertToRubles(package_.prices[currency], currency);
        
        try {
            await db.createPayment(userId, merchantOrderId, package_.prices[currency], package_.credits, currency);

            const formData = {
                shop_id: ENV.SHOP_ID,
                token: ENV.RUKASSA_TOKEN,
                order_id: merchantOrderId,
                amount: amountInRubles,
                user_code: userId.toString(),
                method: curr.method,
                currency_in: currency === 'CRYPTO' ? 'USDT' : currency,
                custom_fields: JSON.stringify({
                    user_id: userId,
                    package_id: packageId,
                    credits: package_.credits,
                    description: `${package_.description} для пользователя ${userId}`
                }),
                webhook_url: `${ENV.WEBHOOK_URL}/rukassa/webhook`,
                success_url: `${ENV.WEBHOOK_URL}/payment/success`,
                fail_url: `${ENV.WEBHOOK_URL}/payment/fail`,
                back_url: `${ENV.WEBHOOK_URL}/payment/back`
            };

            // Изменяем способ отправки данных с URLSearchParams на обычный объект
            const response = await axios.post(
                API_CONFIG.RUKASSA_API_URL,
                formData,
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'  // Изменено на application/json
                    },
                    timeout: 10000
                }
            );

            if (response.data.error) {
                if (response.data.error === '300') {
                    throw new Error(`Способ оплаты "${curr.name}" временно недоступен. Пожалуйста, выберите другой способ оплаты.`);
                }
                throw new Error(response.data.message || response.data.error);
            }

            const paymentUrl = response.data.url || response.data.link;
            if (!paymentUrl) {
                throw new Error('Не удалось получить ссылку на оплату');
            }

            return paymentUrl;

        } catch (error) {
            await db.deletePayment(merchantOrderId);
            throw error;
        }
    }

    async handleWebhook(data: any): Promise<void> {
        try {
            const payment = await db.getPaymentByMerchantId(data.merchant_order_id);
            if (!payment) {
                throw new Error('Платёж не найден');
            }

            // Добавляем логирование для отладки
            console.log('Webhook payment data:', {
                paymentId: payment.id,
                userId: payment.user_id,
                status: data.payment_status,
                orderId: data.order_id
            });

            await db.updatePaymentStatus(payment.id, data.payment_status, data.order_id);

            if (data.payment_status === 'paid') {
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

    getAvailablePackages(currency: SupportedCurrency): PaymentPackage[] {
        return CREDIT_PACKAGES.filter(pkg => pkg.prices[currency] > 0);
    }
}

export let paymentService: PaymentService;

export function initPaymentService(bot: Telegraf): void {
    paymentService = new PaymentService(bot);
}