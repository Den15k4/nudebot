export const MENU_ACTIONS = {
    BUY_CREDITS: '💳 Купить кредиты',
    CHECK_BALANCE: '💰 Баланс',
    HELP: '❓ Помощь',
    BACK: '◀️ Назад',
    ACCEPT_RULES: '✅ Принимаю правила',
    VIEW_RULES: '📜 Правила использования'
} as const;

export const ADMIN_ACTIONS = {
    STATS: '📊 Статистика'
} as const;

export const API_CONFIG = {
    RUKASSA_API_URL: 'https://lk.rukassa.pro/api/v1/create',
    CLOTHOFF_API_URL: 'https://public-api.clothoff.net'
} as const;

export const CURRENCY_RATES = {
    RUB: 1,
    KZT: 0.21,
    UZS: 0.0075,
    CRYPTO: 95,
    RUB_SBP: 1
} as const;