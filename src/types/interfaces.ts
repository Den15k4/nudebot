import { ParseMode } from 'telegraf/typings/core/types/typegram';

export interface MessageOptions {
    reply_markup?: any;
    parse_mode?: ParseMode;
    [key: string]: any;
}

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
}

export interface PhotoStats {
    total_processed: number;
    successful_photos: number;
    failed_photos: number;
    avg_processing_time: number;
}

export interface ReferralTransaction {
    username: string;
    amount: number;
    created_at: Date;
    referrer_id: number;
    referral_id: number;
    payment_id?: number;
}

export type SupportedCurrency = 'RUB' | 'KZT' | 'UZS' | 'CRYPTO' | 'RUB_SBP';

export interface Currency {
    code: SupportedCurrency;
    symbol: string;
    name: string;
    method: string;
    minAmount: number;
}

export interface PaymentPackage {
    id: number;
    credits: number;
    prices: Record<SupportedCurrency, number>;
    description: string;
}

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