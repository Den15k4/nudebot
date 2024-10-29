declare module 'telegraf' {
    interface Telegraf {
        telegram: {
            setWebhook(url: string): Promise<boolean>;
            deleteWebhook(): Promise<boolean>;
            getFile(fileId: string): Promise<any>;
            sendMessage(chatId: number | string, text: string, extra?: any): Promise<any>;
            sendPhoto(chatId: number | string, photo: any, extra?: any): Promise<any>;
            deleteMessage(chatId: number | string, messageId: number): Promise<boolean>;
        };
        stop(reason?: string): Promise<void>;
        launch(): Promise<void>;
    }
}