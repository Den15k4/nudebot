// Типы платежей
export enum PaymentStatus {
    PENDING = 'pending',
    PAID = 'paid',
    FAILED = 'failed',
    CANCELED = 'canceled',
    EXPIRED = 'expired',
    REFUNDED = 'refunded'
}

// Методы оплаты
export enum PaymentMethod {
    CARD = 'card',           // Visa/MC/MIR
    CARD_KZT = 'card_kzt',   // Visa/MC KZT
    CARD_UZS = 'card_uzs',   // Visa/MC UZS
    CRYPTO = 'crypta',       // USDT TRC20
    SBP = 'sbp'             // Система быстрых платежей
}

// Статусы обработки изображений
export enum ProcessingStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELED = 'canceled'
}

// Типы ошибок обработки
export enum ProcessingError {
    AGE_RESTRICTION = 'AGE_RESTRICTION',
    INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS',
    INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
    FILE_TOO_LARGE = 'FILE_TOO_LARGE',
    INVALID_FORMAT = 'INVALID_FORMAT',
    API_ERROR = 'API_ERROR',
    NETWORK_ERROR = 'NETWORK_ERROR'
}

// Статусы реферальных выводов
export enum WithdrawalStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    REJECTED = 'rejected',
    CANCELED = 'canceled'
}

// Методы вывода средств
export enum WithdrawalMethod {
    CARD = 'card',           // Банковская карта
    USDT = 'usdt',          // USDT TRC20
    QIWI = 'qiwi',          // QIWI кошелек
    YOOMONEY = 'yoomoney'   // ЮMoney
}

// Поддерживаемые валюты
export enum Currency {
    RUB = 'RUB',
    KZT = 'KZT',
    UZS = 'UZS',
    CRYPTO = 'CRYPTO',
    RUB_SBP = 'RUB_SBP'
}

// Роли пользователей
export enum UserRole {
    USER = 'user',
    ADMIN = 'admin',
    MODERATOR = 'moderator',
    BANNED = 'banned'
}

// Действия в меню
export enum MenuAction {
    PROCESS_PHOTO = 'action_process_photo',
    BUY_CREDITS = 'action_buy',
    CHECK_BALANCE = 'action_balance',
    SHOW_REFERRALS = 'action_referrals',
    SHOW_HELP = 'action_help',
    BACK = 'action_back',
    ACCEPT_RULES = 'action_accept_rules',
    VIEW_RULES = 'action_rules',
    WITHDRAW = 'action_withdraw',
    CANCEL_PROCESSING = 'action_cancel_processing'
}

// Действия администратора
export enum AdminAction {
    SHOW_STATS = 'admin_stats',
    SEND_BROADCAST = 'admin_broadcast',
    MANAGE_SETTINGS = 'admin_settings',
    MANAGE_WITHDRAWALS = 'admin_withdrawals',
    BAN_USER = 'admin_ban_user',
    UNBAN_USER = 'admin_unban_user',
    VIEW_LOGS = 'admin_view_logs'
}

// Типы уведомлений
export enum NotificationType {
    SUCCESS = 'success',
    ERROR = 'error',
    WARNING = 'warning',
    INFO = 'info'
}

// Состояния обработки
export enum ProcessingStep {
    UPLOAD = 'upload',
    VALIDATION = 'validation',
    QUEUE = 'queue',
    PROCESSING = 'processing',
    COMPLETION = 'completion'
}

// Форматы изображений
export enum ImageFormat {
    JPEG = 'image/jpeg',
    PNG = 'image/png',
    WEBP = 'image/webp'
}

// Коды ошибок API
export enum ApiErrorCode {
    RATE_LIMIT = 'RATE_LIMIT',
    UNAUTHORIZED = 'UNAUTHORIZED',
    FORBIDDEN = 'FORBIDDEN',
    NOT_FOUND = 'NOT_FOUND',
    SERVER_ERROR = 'SERVER_ERROR',
    MAINTENANCE = 'MAINTENANCE'
}

// Типы логов
export enum LogLevel {
    ERROR = 'error',
    WARN = 'warn',
    INFO = 'info',
    DEBUG = 'debug',
    TRACE = 'trace'
}

// Типы метрик
export enum MetricType {
    COUNTER = 'counter',
    GAUGE = 'gauge',
    HISTOGRAM = 'histogram',
    SUMMARY = 'summary'
}

// Статус здоровья сервиса
export enum HealthStatus {
    OK = 'ok',
    WARNING = 'warning',
    ERROR = 'error',
    MAINTENANCE = 'maintenance'
}

// Форматы времени
export enum TimeFormat {
    FULL = 'full',
    DATE = 'date',
    TIME = 'time',
    RELATIVE = 'relative'
}

// Направление сортировки
export enum SortDirection {
    ASC = 'asc',
    DESC = 'desc'
}

// Экспорт всех перечислений
export const Enums = {
    PaymentStatus,
    PaymentMethod,
    ProcessingStatus,
    ProcessingError,
    WithdrawalStatus,
    WithdrawalMethod,
    Currency,
    UserRole,
    MenuAction,
    AdminAction,
    NotificationType,
    ProcessingStep,
    ImageFormat,
    ApiErrorCode,
    LogLevel,
    MetricType,
    HealthStatus,
    TimeFormat,
    SortDirection
};