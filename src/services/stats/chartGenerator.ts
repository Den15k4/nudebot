export class ChartGenerator {
    async generateDashboard(): Promise<Buffer> {
        // Базовая реализация
        return Buffer.from('График статистики будет доступен в следующем обновлении');
    }

    async generateChart(chartType: string): Promise<Buffer> {
        // Базовая реализация
        return Buffer.from('График будет доступен в следующем обновлении');
    }
}