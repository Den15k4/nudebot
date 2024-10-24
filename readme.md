# Avatar Generation Bot

Телеграм бот для генерации стилизованных аватаров с использованием Clothoff API.

## Развертывание на Railway

1. Форкните репозиторий на GitHub

2. Создайте новый проект на Railway и подключите его к вашему GitHub репозиторию

3. Добавьте следующие переменные окружения в Railway:
   ```
   BOT_TOKEN=ваш_токен_бота
   CLOTHOFF_KEY=ваш_ключ_api
   DATABASE_URL=postgresql://user:password@host:5432/dbname
   WEBHOOK_BASE_URL=https://your-app-name.railway.app
   WEBHOOK_HOST=0.0.0.0
   WEBHOOK_PORT=8080
   ```

4. Включите Postgres Add-on в Railway:
   - Перейдите в раздел Add-ons
   - Выберите PostgreSQL
   - Railway автоматически добавит переменные окружения для базы данных

5. Нажмите Deploy для запуска бота

## Локальное развертывание

1. Клонируйте репозиторий:
   ```bash
   git clone https://github.com/your-username/avatar-bot.git
   cd avatar-bot
   ```

2. Создайте файл .env с необходимыми переменными окружения

3. Запустите с помощью Docker Compose:
   ```bash
   docker-compose up --build
   ```

## Переменные окружения

- `BOT_TOKEN` - токен Telegram бота
- `CLOTHOFF_KEY` - ключ API Clothoff
- `DATABASE_URL` - URL подключения к PostgreSQL
- `WEBHOOK_BASE_URL` - базовый URL для веб-хуков
- `WEBHOOK_HOST` - хост для веб-хуков (0.0.0.0 для Railway)
- `WEBHOOK_PORT` - порт для веб-хуков (8080 для Railway)

## Команды бота

- `/start` - начать работу с ботом
- `/quality` - настройка качества генерации
- `/stats` - статистика использования
- `/history` - история генераций
- `/favorite` - управление избранными стилями
- `/settings` - настройки уведомлений
- `/help` - справка по командам

## Обновление базы данных

Для обновления схемы базы данных используйте Alembic:

```bash
# Создание новой миграции
alembic revision --autogenerate -m "description"

# Применение миграций
alembic upgrade head
```
