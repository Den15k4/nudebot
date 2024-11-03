import winston from 'winston';
import { ENV } from '../config/environment';

// Форматтер для логов
const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Создаем логгер
export const logger = winston.createLogger({
    level: ENV.LOG_LEVEL,
    format: logFormat,
    defaultMeta: { service: 'telegram-bot' },
    transports: [
        // Файл с ошибками
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: ENV.LOG_FILE_MAX_SIZE,
            maxFiles: ENV.LOG_MAX_FILES,
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            )
        }),

        // Общий файл логов
        new winston.transports.File({
            filename: 'logs/combined.log',
            maxsize: ENV.LOG_FILE_MAX_SIZE,
            maxFiles: ENV.LOG_MAX_FILES
        }),

        // Консоль (только в development)
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({
                    format: 'YYYY-MM-DD HH:mm:ss'
                }),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    let log = `${timestamp} [${level}]: ${message}`;
                    if (Object.keys(meta).length > 0) {
                        log += `\n${JSON.stringify(meta, null, 2)}`;
                    }
                    return log;
                })
            )
        })
    ],
    // Обработка исключений и отклонений
    exceptionHandlers: [
        new winston.transports.File({
            filename: 'logs/exceptions.log',
            maxsize: ENV.LOG_FILE_MAX_SIZE,
            maxFiles: ENV.LOG_MAX_FILES
        })
    ],
    rejectionHandlers: [
        new winston.transports.File({
            filename: 'logs/rejections.log',
            maxsize: ENV.LOG_FILE_MAX_SIZE,
            maxFiles: ENV.LOG_MAX_FILES
        })
    ]
});

// Функция для логирования HTTP запросов
export const httpLogger = {
    request: (req: any) => {
        logger.info('HTTP Request', {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: req.method === 'GET' ? undefined : req.body,
            ip: req.ip
        });
    },
    response: (res: any, duration: number) => {
        logger.info('HTTP Response', {
            statusCode: res.statusCode,
            duration: `${duration}ms`
        });
    }
};

// Функция для логирования ошибок Telegram
export const telegramLogger = {
    error: (error: any, context?: string) => {
        logger.error('Telegram Error', {
            context,
            error: error.message,
            code: error.code,
            description: error.description,
            stack: error.stack
        });
    },
    warning: (message: string, data?: any) => {
        logger.warn('Telegram Warning', {
            message,
            ...data
        });
    }
};

// Функция для логирования ошибок платежной системы
export const paymentLogger = {
    error: (error: any, paymentData?: any) => {
        logger.error('Payment Error', {
            error: error.message,
            code: error.code,
            payment: paymentData,
            stack: error.stack
        });
    },
    success: (paymentData: any) => {
        logger.info('Payment Success', paymentData);
    },
    webhook: (data: any) => {
        logger.info('Payment Webhook', data);
    }
};

// Функция для логирования действий пользователей
export const userLogger = {
    action: (userId: number, action: string, data?: any) => {
        logger.info('User Action', {
            userId,
            action,
            ...data
        });
    },
    error: (userId: number, error: any, context?: string) => {
        logger.error('User Error', {
            userId,
            context,
            error: error.message,
            stack: error.stack
        });
    }
};

// Функция для логирования обработки изображений
export const imageLogger = {
    start: (userId: number, fileId: string) => {
        logger.info('Image Processing Start', {
            userId,
            fileId
        });
    },
    success: (userId: number, processingTime: number) => {
        logger.info('Image Processing Success', {
            userId,
            processingTime
        });
    },
    error: (userId: number, error: any) => {
        logger.error('Image Processing Error', {
            userId,
            error: error.message,
            stack: error.stack
        });
    }
};

// Функция для логирования действий администратора
export const adminLogger = {
    action: (adminId: number, action: string, data?: any) => {
        logger.info('Admin Action', {
            adminId,
            action,
            ...data
        });
    },
    error: (adminId: number, error: any, context?: string) => {
        logger.error('Admin Error', {
            adminId,
            context,
            error: error.message,
            stack: error.stack
        });
    }
};

// Метрики производительности
export const metrics = {
    timing: (label: string, duration: number) => {
        logger.info('Performance Metric', {
            label,
            duration,
            timestamp: new Date().toISOString()
        });
    },
    counter: (label: string, value: number) => {
        logger.info('Counter Metric', {
            label,
            value,
            timestamp: new Date().toISOString()
        });
    }
};