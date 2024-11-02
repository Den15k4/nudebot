import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import { ENV } from '../config/environment';
import { ApiResponse, ProcessingResult } from '../types/interfaces';
import { db } from './database';
import { Telegram } from 'telegraf';
import { logger } from '../index';
import { promisify } from 'util';
import * as FileType from 'file-type';

class ImageProcessService {
    private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    private readonly MAX_RETRY_ATTEMPTS = 3;
    private readonly RETRY_DELAY = 2000; // 2 seconds
    private readonly ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
    private readonly MIN_IMAGE_DIMENSION = 100;
    private readonly MAX_IMAGE_DIMENSION = 4096;

    private apiClient = axios.create({
        baseURL: 'https://public-api.clothoff.net',
        headers: {
            'accept': 'application/json',
            'x-api-key': ENV.CLOTHOFF_API_KEY
        },
        timeout: 120000
    });

    constructor() {
        // Добавляем перехватчик для логирования запросов
        this.apiClient.interceptors.request.use((config) => {
            logger.info('API Request:', {
                method: config.method,
                url: config.url,
                headers: config.headers
            });
            return config;
        });

        // Добавляем перехватчик для логирования ответов
        this.apiClient.interceptors.response.use(
            (response) => {
                logger.info('API Response:', {
                    status: response.status,
                    data: response.data
                });
                return response;
            },
            (error) => {
                logger.error('API Error:', {
                    message: error.message,
                    response: error.response?.data
                });
                return Promise.reject(error);
            }
        );
    }

    private async validateImage(imageBuffer: Buffer): Promise<void> {
        // Проверка размера
        if (imageBuffer.length > this.MAX_FILE_SIZE) {
            throw new Error(`Размер файла превышает ${this.MAX_FILE_SIZE / 1024 / 1024}MB`);
        }

        // Проверка формата
        const fileType = await FileType.fromBuffer(imageBuffer);
        if (!fileType || !this.ALLOWED_MIME_TYPES.includes(fileType.mime)) {
            throw new Error('Неподдерживаемый формат изображения. Разрешены только JPEG, PNG и WebP');
        }
    }

    // Функция повторных попыток
    private async retryOperation<T>(
        operation: () => Promise<T>,
        retryCount = 0
    ): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (
                retryCount < this.MAX_RETRY_ATTEMPTS &&
                (axios.isAxiosError(error) || error instanceof Error)
            ) {
                logger.warn(`Попытка ${retryCount + 1} не удалась, повторяем...`, {
                    error: error.message
                });

                await new Promise(resolve => 
                    setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, retryCount))
                );

                return this.retryOperation(operation, retryCount + 1);
            }
            throw error;
        }
    }

    // Основной метод обработки изображения
    async processImage(imageBuffer: Buffer, userId: number): Promise<ProcessingResult> {
        try {
            // Валидация изображения
            await this.validateImage(imageBuffer);

            const formData = new FormData();
            const id_gen = `user_${userId}_${Date.now()}`;
            
            formData.append('cloth', 'naked');
            formData.append('image', imageBuffer, {
                filename: 'image.jpg',
                contentType: 'image/jpeg'
            });
            formData.append('id_gen', id_gen);
            formData.append('webhook', ENV.WEBHOOK_URL);

            logger.info('Начало обработки изображения:', {
                userId,
                id_gen,
                fileSize: imageBuffer.length
            });

            const response = await this.retryOperation(async () => {
                return this.apiClient.post('/undress', formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'x-api-key': ENV.CLOTHOFF_API_KEY
                    },
                    maxBodyLength: Infinity,
                    timeout: 120000
                });
            });
            
            const apiResponse: ApiResponse = response.data;
            
            // Расширенная обработка ошибок
            if (apiResponse.error) {
                if (apiResponse.error === 'Insufficient balance') {
                    throw new Error('INSUFFICIENT_BALANCE');
                }
                if (apiResponse.error.toLowerCase().includes('age') || 
                    apiResponse.age === 'young') {
                    throw new Error('AGE_RESTRICTION');
                }
                throw new Error(`API Error: ${apiResponse.error}`);
            }
            
            // Проверяем наличие обязательных полей в ответе
            if (!apiResponse.queue_time && !apiResponse.queue_num) {
                throw new Error('Некорректный ответ от API');
            }

            await db.setUserPendingTask(userId, id_gen);
            
            logger.info('Изображение успешно отправлено на обработку:', {
                userId,
                id_gen,
                queueTime: apiResponse.queue_time,
                queuePosition: apiResponse.queue_num
            });

            return {
                queueTime: apiResponse.queue_time,
                queueNum: apiResponse.queue_num,
                apiBalance: apiResponse.api_balance,
                idGen: id_gen
            };
        } catch (error) {
            logger.error('Ошибка при обработке изображения:', {
                userId,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            if (axios.isAxiosError(error)) {
                if (error.response?.data) {
                    if (error.response.data.error === 'Insufficient balance') {
                        throw new Error('INSUFFICIENT_BALANCE');
                    }
                    if (error.response.data.error.includes('Age') || 
                        error.response.data.age === 'young') {
                        throw new Error('AGE_RESTRICTION');
                    }
                    throw new Error(`API Error: ${error.response.data.error || 'Unknown error'}`);
                }
                throw new Error(`Network error: ${error.message}`);
            }
            throw error;
        }
    }

    // Загрузка файла из Telegram
    async downloadTelegramFile(fileId: string, telegram: Telegram): Promise<Buffer> {
        try {
            logger.info('Начало загрузки файла из Telegram:', { fileId });

            const file = await this.retryOperation(async () => {
                const fileInfo = await telegram.getFile(fileId);
                if (!fileInfo.file_path) {
                    throw new Error('Не удалось получить путь к файлу');
                }
                return fileInfo;
            });

            if (!file.file_path) {
                throw new Error('Не удалось получить путь к файлу');
            }

            const response = await this.retryOperation(async () => {
                return axios.get(
                    `https://api.telegram.org/file/bot${ENV.BOT_TOKEN}/${file.file_path}`,
                    { 
                        responseType: 'arraybuffer',
                        timeout: 30000
                    }
                );
            });

            const buffer = Buffer.from(response.data);
            
            // Проверяем размер и формат загруженного файла
            await this.validateImage(buffer);

            logger.info('Файл успешно загружен:', {
                fileId,
                size: buffer.length,
                filePath: file.file_path
            });

            return buffer;
        } catch (error) {
            logger.error('Ошибка при загрузке файла из Telegram:', {
                fileId,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            if (axios.isAxiosError(error)) {
                throw new Error(`Ошибка загрузки: ${error.message}`);
            }
            throw error;
        }
    }

    // Метод очистки задач
    async cleanupPendingTasks(olderThanHours: number = 24): Promise<void> {
        try {
            const result = await db.pool.query(
                `UPDATE users 
                 SET pending_task_id = NULL 
                 WHERE pending_task_id IS NOT NULL 
                 AND last_used < NOW() - INTERVAL '${olderThanHours} hours'`
            );
            
            logger.info(`Очищено ${result.rowCount} зависших задач`);
        } catch (error) {
            logger.error('Ошибка при очистке зависших задач:', error);
        }
    }
}

export const imageProcessor = new ImageProcessService();