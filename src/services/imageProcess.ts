import axios from 'axios';
import FormData from 'form-data';
import { ENV } from '../config/environment';
import { ApiResponse, ProcessingResult } from '../types/interfaces';
import { db } from './database';
import { Telegram } from 'telegraf';

class ImageProcessService {
    private apiClient = axios.create({
        baseURL: 'https://public-api.clothoff.net',
        headers: {
            'accept': 'application/json',
            'x-api-key': ENV.CLOTHOFF_API_KEY
        }
    });

    async processImage(imageBuffer: Buffer, userId: number): Promise<ProcessingResult> {
        const formData = new FormData();
        const id_gen = `user_${userId}_${Date.now()}`;
        
        formData.append('cloth', 'naked');
        formData.append('image', imageBuffer, {
            filename: 'image.jpg',
            contentType: 'image/jpeg'
        });
        formData.append('id_gen', id_gen);
        formData.append('webhook', ENV.WEBHOOK_URL);

        try {
            const response = await this.apiClient.post('/undress', formData, {
                headers: {
                    ...formData.getHeaders(),
                    'x-api-key': ENV.CLOTHOFF_API_KEY
                },
                maxBodyLength: Infinity,
                timeout: 120000
            });
            
            const apiResponse: ApiResponse = response.data;
            
            if (apiResponse.error) {
                if (apiResponse.error === 'Insufficient balance') {
                    throw new Error('INSUFFICIENT_BALANCE');
                }
                throw new Error(`API Error: ${apiResponse.error}`);
            }
            
            await db.setUserPendingTask(userId, id_gen);
            
            return {
                queueTime: apiResponse.queue_time,
                queueNum: apiResponse.queue_num,
                apiBalance: apiResponse.api_balance,
                idGen: id_gen
            };
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.data) {
                if (error.response.data.error === 'Insufficient balance') {
                    throw new Error('INSUFFICIENT_BALANCE');
                }
                throw new Error(`API Error: ${error.response.data.error || 'Unknown error'}`);
            }
            throw error;
        }
    }

    

    async downloadTelegramFile(fileId: string, telegram: Telegram): Promise<Buffer> {
        const file = await telegram.getFile(fileId);
        if (!file.file_path) {
            throw new Error('Не удалось получить путь к файлу');
        }

        const response = await axios.get(
            `https://api.telegram.org/file/bot${ENV.BOT_TOKEN}/${file.file_path}`,
            { responseType: 'arraybuffer' }
        );

        return Buffer.from(response.data);
    }
}

export const imageProcessor = new ImageProcessService();