export class StatsExporter {
    async exportStats(format: string): Promise<Buffer> {
        // Базовая реализация - возвращаем текстовый файл
        const data = 'Экспорт статистики будет доступен в следующем обновлении';
        return Buffer.from(data);
    }
}