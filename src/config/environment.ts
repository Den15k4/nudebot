import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const ENV = {
    // Основные настройки бота
    BOT_TOKEN: process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U',
    CLOTHOFF_API_KEY: process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9',
    WEBHOOK_URL: process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app/webhook',
    PORT: parseInt(process.env.PORT || '8080', 10),
    DATABASE_URL: process.env.DATABASE_URL || '',
    
    // Администраторы и безопасность
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()),
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',

    // Настройки Rukassa
    SHOP_ID: process.env.SHOP_ID || '2660',
    RUKASSA_TOKEN: process.env.RUKASSA_TOKEN || '9876a82910927a2c9a43f34cb5ad2de7',
    RUKASSA_SUCCESS_URL: process.env.RUKASSA_SUCCESS_URL || 'https://nudebot-production.up.railway.app/payment/success',
    RUKASSA_FAIL_URL: process.env.RUKASSA_FAIL_URL || 'https://nudebot-production.up.railway.app/payment/fail',
    RUKASSA_BACK_URL: process.env.RUKASSA_BACK_URL || 'https://nudebot-production.up.railway.app/payment/back',

    // Ограничения и таймауты
    MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB в байтах
    API_TIMEOUT: parseInt(process.env.API_TIMEOUT || '120000', 10), // 2 минуты
    MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10),
    RETRY_DELAY: parseInt(process.env.RETRY_DELAY || '2000', 10), // 2 секунды
    RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW || '900000', 10), // 15 минут
    RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '100', 10), // максимум запросов

    // Настройки базы данных
    DB_MAX_CONNECTIONS: parseInt(process.env.DB_MAX_CONNECTIONS || '20', 10),
    DB_IDLE_TIMEOUT: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
    DB_CONNECTION_TIMEOUT: parseInt(process.env.DB_CONNECTION_TIMEOUT || '2000', 10),

    // Настройки логирования
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    LOG_FILE_MAX_SIZE: parseInt(process.env.LOG_FILE_MAX_SIZE || '5242880', 10), // 5MB
    LOG_MAX_FILES: parseInt(process.env.LOG_MAX_FILES || '5', 10),
    
    // Настройки реферальной системы
    MIN_WITHDRAWAL_AMOUNT: parseInt(process.env.MIN_WITHDRAWAL_AMOUNT || '100', 10),
    REFERRAL_PERCENTAGE: parseInt(process.env.REFERRAL_PERCENTAGE || '50', 10),

    // Настройки кэширования
    CACHE_LIMIT: parseInt(process.env.CACHE_LIMIT || '1000', 10)
} as const;

// Пути к статическим файлам
export const PATHS = {
    LOGS: {
        ERROR: path.join(__dirname, '../../logs/error.log'),
        COMBINED: path.join(__dirname, '../../logs/combined.log')
    }
} as const;