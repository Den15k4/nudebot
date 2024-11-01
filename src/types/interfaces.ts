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

export interface ScheduledBroadcast {
    id: string;
    date: Date;
    message: string;
    image?: string;
    keyboard?: any;
}

export interface User {
    user_id: number;
    username: string;
    credits: number;
    created_at: Date;
    last_used?: Date;
    pending_task_id?: string;
    accepted_rules: boolean;
    photos_processed: number;
    total_spent: number;
    last_notification_read?: Date;
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
    photos_processed: number;
    successful_photos: number;
    failed_photos: number;
    avg_processing_time: number;
}

export interface SpecialOffer {
    id?: number;
    title: string;
    description: string;
    discountPercent: number;
    startDate: Date;
    endDate: Date;
    isActive?: boolean;
    minCredits?: number;
    extraCredits?: number;
}

export interface ReferralTransaction {
    username: string;
    amount: number;
    created_at: Date;
    referrer_id: number;
    referral_id: number;
    payment_id?: number;
}

export interface BackupRecord {
    id: number;
    filename: string;
    created_at: Date;
    size_bytes: number;
    status: string;
    error_message?: string;
    storage_path: string;
}

export interface Notification {
    id?: number;
    type: string;
    title: string;
    message: string;
    scheduledFor?: Date;
    specialOfferId?: number;
    isSent?: boolean;
    sentAt?: Date;
}
export interface PhotoProcessingStats {
    date: Date;
    total_processed: number;
    successful: number;
    failed: number;
    avg_processing_time: number;
}

export interface PaymentStats {
    date: Date;
    total_payments: number;
    total_amount: number;
    unique_users: number;
    average_payment: number;
}

export interface UserGrowthStats {
    date: Date;
    new_users: number;
    total_users: number;
}

export interface OfferStats {
    title: string;
    discount_percent: number;
    users_used: number;
    total_amount_saved: number;
    total_purchases: number;
}

export interface TargetedBroadcastOptions {
    userIds: number[];
    message: string;
    image?: Buffer;
    keyboard?: any;
}

export interface NotificationTarget {
    user_id: number;
    last_notification_read: Date | null;
}

export type SupportedCurrency = 'RUB' | 'KZT' | 'UZS' | 'CRYPTO';

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

export interface DetailedStats {
    users: {
        total_users: number;
        active_today: number;
        total_credits: number;
        total_revenue: number;
    };
    photos: {
        total_processed: number;
        successful: number;
        failed: number;
        avg_processing_time: number;
    };
    payments: {
        total_payments: number;
        total_amount: number;
        unique_users: number;
    };
    offers: {
        active_offers: number;
        avg_discount: number;
    };
}