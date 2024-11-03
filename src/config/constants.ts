// Константы действий меню
export const MENU_ACTIONS = {
    PROCESS_PHOTO: 'action_process_photo',
    BUY_CREDITS: 'action_buy',
    CHECK_BALANCE: 'action_balance',
    SHOW_REFERRALS: 'action_referrals',
    SHOW_HELP: 'action_help',
    BACK: 'action_back',
    ACCEPT_RULES: 'action_accept_rules',
    VIEW_RULES: 'action_rules',
    WITHDRAW: 'action_withdraw',
    CANCEL_PROCESSING: 'action_cancel_processing'
} as const;

// Константы для админ-панели
export const ADMIN_ACTIONS = {
    SHOW_STATS: 'admin_stats',
    SEND_BROADCAST: 'admin_broadcast',
    MANAGE_SETTINGS: 'admin_settings',
    MANAGE_WITHDRAWALS: 'admin_withdrawals'
} as const;

// Конфигурация API
export const API_CONFIG = {
    RUKASSA_API_URL: 'https://lk.rukassa.pro/api/v1/create',
    CLOTHOFF_API_URL: 'https://public-api.clothoff.net',
    CLOTHOFF_WEBHOOK_PATH: '/webhook',
    RUKASSA_WEBHOOK_PATH: '/rukassa/webhook'
} as const;

// Курсы валют для конвертации
export const CURRENCY_RATES = {
    RUB: 1,
    KZT: 0.21,
    UZS: 0.0075,
    CRYPTO: 95,
    RUB_SBP: 1
} as const;

// Пакеты кредитов
export const CREDIT_PACKAGES = [
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
] as const;

// Статусы платежей
export const PAYMENT_STATUS = {
    PENDING: 'pending',
    PAID: 'paid',
    FAILED: 'failed',
    CANCELED: 'canceled'
} as const;

// Методы оплаты
export const PAYMENT_METHODS = {
    CARD: 'card',
    CARD_KZT: 'card_kzt',
    CARD_UZS: 'card_uzs',
    CRYPTO: 'crypta',
    SBP: 'sbp'
} as const;

// Ограничения файлов
export const FILE_LIMITS = {
    MAX_SIZE: 10 * 1024 * 1024, // 10MB
    ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
    MIN_DIMENSION: 100,
    MAX_DIMENSION: 4096
} as const;

// Таймауты
export const TIMEOUTS = {
    API_REQUEST: 120000, // 2 минуты
    DB_QUERY: 5000,     // 5 секунд
    WEBHOOK: 10000      // 10 секунд
} as const;

// Настройки реферальной системы
export const REFERRAL_CONFIG = {
    MIN_WITHDRAWAL: 100,     // Минимальная сумма для вывода
    COMMISSION: 0.5,         // 50% от платежа реферала
    MAX_REFERRALS: 1000,    // Максимальное количество рефералов
    WITHDRAWAL_METHODS: ['CARD', 'CRYPTO']
} as const;