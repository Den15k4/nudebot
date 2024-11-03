import { SupportedCurrency } from '../types/interfaces';

// Форматирование чисел
export const formatNumber = {
    // Общее форматирование чисел с разделителями
    default: (num: number): string => {
        return new Intl.NumberFormat('ru-RU').format(num);
    },

    // Форматирование денежных сумм
    currency: (amount: number, currency: SupportedCurrency): string => {
        const formatter = new Intl.NumberFormat('ru-RU', {
            style: 'currency',
            currency: currency === 'CRYPTO' ? 'USD' : currency,
            minimumFractionDigits: currency === 'CRYPTO' ? 2 : 0,
            maximumFractionDigits: currency === 'CRYPTO' ? 2 : 0
        });

        let formatted = formatter.format(amount);
        
        // Специальная обработка для криптовалюты
        if (currency === 'CRYPTO') {
            formatted = `${formatted.replace('$', '')} USDT`;
        }

        return formatted;
    },

    // Форматирование процентов
    percent: (num: number): string => {
        return new Intl.NumberFormat('ru-RU', {
            style: 'percent',
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        }).format(num / 100);
    },

    // Форматирование размера файлов
    fileSize: (bytes: number): string => {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }
};

// Форматирование дат и времени
export const formatDate = {
    // Полная дата со временем
    full: (date: Date): string => {
        return date.toLocaleString('ru-RU', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    // Только дата
    date: (date: Date): string => {
        return date.toLocaleDateString('ru-RU', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    },

    // Только время
    time: (date: Date): string => {
        return date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    // Относительное время (например, "5 минут назад")
    relative: (date: Date): string => {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (minutes < 1) return 'только что';
        if (minutes < 60) return `${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')} назад`;
        if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
        if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;

        return formatDate.date(date);
    }
};

// Форматирование длительности
export const formatDuration = {
    // Форматирование времени в секундах
    fromSeconds: (seconds: number): string => {
        if (seconds < 60) return `${seconds} сек`;
        if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            return `${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')}`;
        }
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours} ${plural(hours, 'час', 'часа', 'часов')} ${minutes} ${plural(minutes, 'минута', 'минуты', 'минут')}`;
    },

    // Форматирование миллисекунд
    fromMs: (ms: number): string => {
        return formatDuration.fromSeconds(Math.floor(ms / 1000));
    }
};

// Форматирование текста
export const formatText = {
    // Безопасное HTML форматирование
    safeHtml: (text: string): string => {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },

    // Ограничение длины текста
    truncate: (text: string, length: number): string => {
        if (text.length <= length) return text;
        return text.slice(0, length - 3) + '...';
    },

    // Форматирование списка
    list: (items: string[]): string => {
        return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
    },

    // Форматирование ссылки
    link: (text: string, url: string): string => {
        return `<a href="${url}">${formatText.safeHtml(text)}</a>`;
    }
};

// Вспомогательная функция для склонения слов
export function plural(number: number, one: string, few: string, many: string): string {
    const mod10 = number % 10;
    const mod100 = number % 100;

    if (mod100 >= 11 && mod100 <= 20) {
        return many;
    }

    if (mod10 === 1) {
        return one;
    }

    if (mod10 >= 2 && mod10 <= 4) {
        return few;
    }

    return many;
}

// Форматирование статистики
export const formatStats = {
    // Форматирование реферальной статистики
    referral: (count: number, earnings: number): string => {
        return `👥 Приглашено: ${formatNumber.default(count)} ${plural(count, 'пользователь', 'пользователя', 'пользователей')}\n` +
               `💰 Заработано: ${formatNumber.currency(earnings, 'RUB')}`;
    },

    // Форматирование статистики обработки фото
    photoProcessing: (total: number, success: number, failed: number): string => {
        return `📸 Всего обработано: ${formatNumber.default(total)}\n` +
               `✅ Успешно: ${formatNumber.default(success)}\n` +
               `❌ Ошибок: ${formatNumber.default(failed)}`;
    },

    // Форматирование статистики платежей
    payments: (total: number, count: number): string => {
        return `💰 Сумма: ${formatNumber.currency(total, 'RUB')}\n` +
               `🔄 Количество: ${formatNumber.default(count)}`;
    }
};