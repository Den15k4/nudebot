import { Telegraf } from 'telegraf';
import axios from 'axios';
import { ENV } from '../config/environment';
import { API_CONFIG, CURRENCY_RATES } from '../config/constants';
import { db } from './database';
import { 
    SupportedCurrency, 
    Currency, 
    PaymentPackage, 
    CreditPackage,
    PaymentResponse 
} from '../types/interfaces';
import { logger } from '../index';

export const SUPPORTED_CURRENCIES: Currency[] = [
    { 
        code: 'RUB', 
        symbol: '₽', 
        name: 'Visa/MC/MIR', 
        method: 'card',
        minAmount: 300
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Visa/MC [KZT]', 
        method: 'card_kzt',
        minAmount: 32500
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'Visa/MC [UZS]', 
        method: 'card_uzs',
        minAmount: 86000
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Crypto', 
        method: 'crypta',
        minAmount: 3
    },
    {
        code: 'RUB_SBP',
        symbol: '₽',
        name: 'СБП',
        method: 'sbp',
        minAmount: 300
    }
];

export const CREDIT_PACKAGES: CreditPackage[] = [
    {
        id: 1,
        credits: 3,
        prices: {
            RUB: 300,
            KZT: 32500,
            UZS: 86000,
            CRYPTO: 3.00,
            RUB_SBP: 300
        },
        description: '3 генерации'
    },
    {
        id: 2,
        credits: 7,
        prices: {
            RUB: 600,
            KZT: 58500,
            UZS: 154800,
            CRYPTO: 6.00,
            RUB_SBP: 600
        },
        description: '7 генераций'
    },
    {
        id: 3,
        credits: 15,
        prices: {
            RUB: 1200,
            KZT: 108000,
            UZS: 286000,
            CRYPTO: 12.00,
            RUB_SBP: 1200
        },
        description: '15 генераций'
    },
    {
        id: 4,
        credits: 30,
        prices: {
            RUB: 2000,
            KZT: 195000,
            UZS: 516000,
            CRYPTO: 20.00,
            RUB_SBP: 2000
        },
        description: '30 генераций'
    }
];

export class PaymentService {
    private readonly MAX_RETRY_ATTEMPTS = 3;
    private readonly RETRY_DELAY = 2000;

    constructor(private bot: Telegraf) {}

    private convertToRubles(amount: number, currency: SupportedCurrency): string {
        const rubles = Math.round(amount * CURRENCY_RATES[currency]);
        return rubles.toString();
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

            const paymentData = {
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

            logger.info('Создание платежа:', {
                userId,
                packageId,
                currency,
                amount: package_.prices[currency]
            });

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
                if (response.data.error === '300') {
                    throw new Error(`Способ оплаты "${curr.name}" временно недоступен. Пожалуйста, выберите другой способ оплаты.`);
                }
                throw new Error(response.data.message || response.data.error);
            }

            const paymentUrl = response.data.url || response.data.link;
            if (!paymentUrl) {
                throw new Error('Не удалось получить ссылку на оплату');
            }

            logger.info('Платёж создан успешно:', {
                userId,
                merchantOrderId,
                paymentUrl
            });

            return paymentUrl;

        } catch (error) {
            logger.error('Ошибка при создании платежа:', {
                userId,
                packageId,
                currency,
                error
            });

            await db.deletePayment(merchantOrderId);
            throw error;
        }
    }

    async handleWebhook(data: any): Promise<void> {
        try {
            logger.info('Получен webhook от платёжной системы:', data);

            const payment = await db.getPaymentByMerchantId(data.merchant_order_id);
            if (!payment) {
                throw new Error('Платёж не найден');
            }

            await db.updatePaymentStatus(payment.id, data.payment_status, data.order_id);

            if (data.payment_status === 'paid') {
                await Promise.all([
                    db.updateUserCredits(payment.user_id, payment.credits),
                    db.processReferralPayment(payment.id)
                ]);
                
                const curr = SUPPORTED_CURRENCIES.find(c => c.code === payment.currency);
                await this.bot.telegram.sendMessage(
                    payment.user_id,
                    `✅ Оплата ${payment.amount} ${curr?.symbol || payment.currency} успешно получена!\n` +
                    `На ваш счет зачислено ${payment.credits} кредитов.`
                );

                logger.info('Платёж обработан успешно:', {
                    userId: payment.user_id,
                    amount: payment.amount,
                    credits: payment.credits
                });
            }
        } catch (error) {
            logger.error('Ошибка обработки webhook:', error);
            throw error;
        }
    }

    getAvailablePackages(currency: SupportedCurrency): CreditPackage[] {
        return CREDIT_PACKAGES.filter(pkg => pkg.prices[currency] > 0);
    }
}

export let paymentService: PaymentService;

export function initPaymentService(bot: Telegraf): void {
    paymentService = new PaymentService(bot);
    logger.info('Платёжный сервис инициализирован');
}