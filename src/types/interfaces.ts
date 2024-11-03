import { ParseMode } from 'telegraf/typings/core/types/typegram';

// Ошибки
export class TransactionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TransactionError';
    }
}

// Базовые интерфейсы
export interface MessageOptions {
    reply_markup?: any;
    parse_mode?: ParseMode;
    disable_web_page_preview?: boolean;
    disable_notification?: boolean;
    protect_content?: boolean;
    reply_to_message_id?: number;
    [key: string]: any;
}

// Интерфейсы для API
export interface ApiResponse {
    queue_time?: number;
    queue_num?: number;
    api_balance?: number;
    id_gen?: string;
    error?: string;
    status?: string;
    img_message?: string;
    img_message_2?: string;
    age?: string;
}

export interface ProcessingResult {
    queueTime?: number;
    queueNum?: number;
    apiBalance?: number;
    idGen?: string;
}

export interface WebhookBody {
    id_gen?: string;
    status?: string;
    img_message?: string;
    img_message_2?: string;
    result?: string;
    error?: string;
}

// Интерфейсы для базы данных
export interface User {
    user_id: number;
    username: string;
    credits: number;
    created_at: Date;
    last_used?: Date;
    pending_task_id?: string;
    accepted_rules: boolean;
    referrer_id?: number;
    referral_earnings: number;
    total_spent?: number;
    photos_processed?: number;
}

export interface Payment {
    id: number;
    user_id: number;
    order_id: string;
    merchant_order_id: string;
    amount: number;
    credits: number;
    status: string;
    currency: string;
    created_at: Date;
    updated_at: Date;
    payment_method?: string;
    error_message?: string;
}

export interface PhotoStats {
    total_processed: number;
    successful_photos: number;
    failed_photos: number;
    avg_processing_time: number;
}

// Интерфейсы для реферальной системы
export interface ReferralTransaction {
    id: number;
    referrer_id: number;
    referral_id: number;
    amount: number;
    created_at: Date;
    status: string;
    payment_id?: number;
}

export interface ReferralWithdrawal {
    id: number;
    user_id: number;
    amount: number;
    status: string;
    payment_details: any;
    created_at: Date;
    processed_at?: Date;
}

export interface ReferralStats {
    count: number;
    earnings: number;
    withdrawals: number;
    pending_withdrawals: number;
}

// Интерфейсы для платежей
export type SupportedCurrency = 'RUB' | 'KZT' | 'UZS' | 'CRYPTO' | 'RUB_SBP';

export interface Currency {
    code: SupportedCurrency;
    symbol: string;
    name: string;
    method: string;
    minAmount: number;
}

export interface CreditPackage {
    id: number;
    credits: number;
    prices: Record<SupportedCurrency, number>;
    description: string;
}

export interface PaymentPackage {
    id: number;
    credits: number;
    prices: Record<SupportedCurrency, number>;
    description: string;
}

// Интерфейсы для Rukassa
export interface RukassaPaymentRequest {
    shop_id: string;
    token: string;
    order_id: string;
    amount: string;
    user_code: string;
    method: string;
    currency_in: string;
    custom_fields: string;
    webhook_url: string;
    success_url: string;
    fail_url: string;
    back_url: string;
}

export interface RukassaWebhookBody {
    shop_id: string;
    amount: string;
    order_id: string;
    payment_status: string;
    payment_method: string;
    custom_fields: string;
    merchant_order_id: string;
    sign: string;
    status?: string;
    currency?: string;
    description?: string;
    test?: boolean;
}

export interface PaymentResponse {
    status: boolean;
    error?: string;
    message?: string;
    url?: string;
    link?: string;
    id?: number;
    hash?: string;
    order_id?: string;
}

// Интерфейсы для админ-панели
export interface AdminStats {
    users: {
        total: number;
        active_24h: number;
        paid: number;
    };
    photos: {
        total_processed: number;
        successful: number;
        failed: number;
    };
    payments: {
        total_amount: number;
    };
}

export interface PhotoProcessingStats {
    success: boolean;
    errorMessage?: string;
    processingTime?: number;
    fileSize?: number;
}

// Интерфейсы для клавиатур
export interface CustomInlineKeyboardButton {
    text: string;
    callback_data?: string;
    url?: string;
}

export interface KeyboardOptions {
    userId?: number;
    hideBackButton?: boolean;
    disabledButtons?: string[];
}