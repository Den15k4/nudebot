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
        name: 'Банковская карта / СБП (RUB)', 
        method: 'card,sbp',
        minAmount: 300
    },
    { 
        code: 'KZT', 
        symbol: '₸', 
        name: 'Kaspi / Карта (KZT)', 
        method: 'card_kzt,kaspi',
        minAmount: 32500
    },
    { 
        code: 'UZS', 
        symbol: 'сум', 
        name: 'CLICK / Карта (UZS)', 
        method: 'card_uzs,click',
        minAmount: 86000
    },
    { 
        code: 'CRYPTO', 
        symbol: 'USDT', 
        name: 'Криптовалюта (USDT/BTC)', 
        method: 'crypto_tron,crypto_btc,crypto_usdt',
        minAmount: 3
    }
];

export const CREDIT_PACKAGES: PaymentPackage[] = [
    {
        id: 1,
        credits: 3,
        prices: {
            RUB: 300,     // 300₽
            KZT: 0,       // Недоступно
            UZS: 0,       // Недоступно
            CRYPTO: 3.00  // ~300₽
        },
        description: '3 генерации'
    },
    {
        id: 2,
        credits: 7,
        prices: {
            RUB: 600,      // 600₽
            KZT: 58500,    // ~600₽
            UZS: 154800,   // ~1200₽
            CRYPTO: 6.00   // ~600₽
        },
        description: '7 генераций'
    },
    {
        id: 3,
        credits: 15,
        prices: {
            RUB: 1200,     // 1200₽
            KZT: 108000,   // ~1200₽
            UZS: 286000,   // ~2150₽
            CRYPTO: 12.00  // ~1200₽
        },
        description: '15 генераций'
    },
    {
        id: 4,
        credits: 30,
        prices: {
            RUB: 2000,     // 2000₽
            KZT: 195000,   // ~2000₽
            UZS: 516000,   // ~3900₽
            CRYPTO: 20.00  // ~2000₽
        },
        description: '30 генераций'
    }
];

class PaymentService {
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
    
            const formData = new URLSearchParams();
            formData.append('shop_id', ENV.SHOP_ID);
            formData.append('token', ENV.RUKASSA_TOKEN);
            formData.append('order_id', merchantOrderId);
            formData.append('amount', amountInRubles);
            formData.append('user_code', userId.toString()); // Добавляем user_code
    
            // Добавляем метод оплаты в зависимости от валюты
            let paymentMethod: string;
            switch(currency) {
                case 'RUB':
                    paymentMethod = 'card,sbp';
                    break;
                case 'KZT':
                    paymentMethod = 'card_kzt,kaspi';
                    break;
                case 'UZS':
                    paymentMethod = 'card_uzs,click';
                    break;
                case 'CRYPTO':
                    paymentMethod = 'crypto_tron,crypto_btc,crypto_usdt';
                    break;
                default:
                    paymentMethod = 'card';
            }
            
            formData.append('method', paymentMethod);
            formData.append('currency_in', currency === 'CRYPTO' ? 'USDT' : currency);
            
            // Добавляем дополнительную информацию
            formData.append('custom_fields', JSON.stringify({
                user_id: userId,
                package_id: packageId,
                credits: package_.credits,
                description: `${package_.description} для пользователя ${userId}`
            }));
    
            // URLs
            formData.append('webhook_url', `${ENV.WEBHOOK_URL}/rukassa/webhook`);
            formData.append('success_url', `${ENV.WEBHOOK_URL}/payment/success`);
            formData.append('fail_url', `${ENV.WEBHOOK_URL}/payment/fail`);
            formData.append('back_url', `${ENV.WEBHOOK_URL}/payment/back`);
    
            console.log('Создание платежа с параметрами:', {
                amount: amountInRubles,
                method: paymentMethod,
                currency: currency,
                merchantOrderId,
                user_code: userId
            });
    
            const response = await axios.post(
                API_CONFIG.RUKASSA_API_URL,
                formData,
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );
    
            console.log('Ответ Rukassa:', response.data);
    
            if (response.data.error) {
                if (response.data.error === '100' && response.data.message === 'error user_code') {
                    throw new Error('Ошибка создания платежа: некорректный идентификатор пользователя');
                }
                if (response.data.error.includes('method is not activated')) {
                    throw new Error(`Способ оплаты ${currency} временно недоступен. Пожалуйста, выберите другой способ оплаты.`);
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
            
            if (axios.isAxiosError(error)) {
                const errorMessage = error.response?.data?.message || error.response?.data?.error || 'Сервис оплаты временно недоступен';
                console.error('Ошибка API Rukassa:', {
                    status: error.response?.status,
                    data: error.response?.data,
                    userId: userId
                });
                throw new Error(`Ошибка оплаты: ${errorMessage}`);
            }
            
            throw error;
        }
    }

    async handleWebhook(data: any): Promise<void> {
        const payment = await db.getPaymentByMerchantId(data.merchant_order_id);
        if (!payment) {
            throw new Error('Платёж не найден');
        }

        await db.updatePaymentStatus(payment.id, data.payment_status, data.order_id);

        if (data.payment_status === 'paid') {
            await db.updateUserCredits(payment.user_id, payment.credits);
            
            const curr = SUPPORTED_CURRENCIES.find(c => c.code === payment.currency);
            await this.bot.telegram.sendMessage(
                payment.user_id,
                `✅ Оплата ${payment.amount} ${curr?.symbol || payment.currency} успешно получена!\n` +
                `На ваш счет зачислено ${payment.credits} кредитов.`
            );
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