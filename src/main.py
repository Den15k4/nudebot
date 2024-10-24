import logging
import asyncio
from aiogram import Bot, Dispatcher, types
from aiogram.contrib.fsm_storage.memory import MemoryStorage
from aiogram.dispatcher import FSMContext
from aiogram.dispatcher.filters.state import State, StatesGroup
from aiohttp import web
import json
from typing import Optional, Dict, Any
import base64

from config import load_config
from database import Database
from styles import AVATAR_STYLES, QUALITY_PRESETS
from managers.variants import VariantsManager
from managers.quality import QualityManager
from managers.notifications import NotificationManager
from managers.statistics import StatisticsManager
from utils.image_processing import ensure_image_requirements
from utils.webhook_utils import validate_webhook_request, WebhookResponse, setup_webhook_routes

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Загружаем конфигурацию
config = load_config()

# Инициализация бота
bot = Bot(token=config.telegram.token)
storage = MemoryStorage()
dp = Dispatcher(bot, storage=storage)

# Инициализация базы данных
db = Database(config.db.url)

# Инициализация менеджеров
variants_manager = VariantsManager()
quality_manager = QualityManager(db)
notification_manager = NotificationManager(bot, db)
statistics_manager = StatisticsManager(db)

# Состояния FSM
class UserState(StatesGroup):
    waiting_for_photo = State()
    choosing_style = State()
    choosing_position = State()
    choosing_balance = State()
    choosing_variations = State()
    waiting_for_generation = State()

# Активные генерации
active_generations: Dict[str, Dict[str, Any]] = {}

@dp.message_handler(commands=['start'])
async def cmd_start(message: types.Message):
    """Обработчик команды /start"""
    try:
        logger.info(f"Processing /start command from user {message.from_user.id}")
        
        # Регистрируем пользователя
        user = db.register_user(message.from_user.id, message.from_user.username)
        
        # Проверяем подписку
        has_sub, images_left = db.check_subscription(message.from_user.id)
        
        # Создаем клавиатуру
        keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
        keyboard.add(types.KeyboardButton("Создать аватар"))
        
        # Отправляем приветственное сообщение
        await message.answer(
            "👋 Привет! Я бот для создания стильных аватаров.\n"
            "🎨 Я могу преобразовать ваше фото в различных стилях.\n\n"
            "Нажмите 'Создать аватар' чтобы начать!",
            reply_markup=keyboard
        )
        
        await message.answer(
            f"💫 У вас осталось изображений: {images_left}\n"
            f"Используйте /help для получения списка всех команд."
        )
        
    except Exception as e:
        logger.error(f"Error in start command: {e}")
        await message.answer("Произошла ошибка. Пожалуйста, попробуйте позже.")

@dp.message_handler(text="Создать аватар")
async def request_photo(message: types.Message):
    """Обработчик кнопки Создать аватар"""
    try:
        # Проверяем подписку
        has_sub, images_left = db.check_subscription(message.from_user.id)
        
        if images_left <= 0:
            await message.answer(
                "У вас закончились доступные изображения!\n"
                "Скоро будет доступна возможность приобрести дополнительные изображения."
            )
            return
        
        await UserState.waiting_for_photo.set()
        await message.answer(
            f"📸 Отправьте фотографию.\n"
            f"Рекомендации:\n"
            f"- Фото должно быть хорошего качества\n"
            f"- Хорошее освещение\n"
            f"- Чёткое изображение лица\n\n"
            f"Осталось изображений: {images_left}"
        )
        
    except Exception as e:
        logger.error(f"Error in request_photo: {e}")
        await message.answer("Произошла ошибка. Пожалуйста, попробуйте позже.")

@dp.message_handler(content_types=['photo'], state=UserState.waiting_for_photo)
async def process_photo(message: types.Message, state: FSMContext):
    """Обработчик полученной фотографии"""
    try:
        # Скачиваем фото
        photo = await message.photo[-1].download(destination_file=io.BytesIO())
        photo_bytes = photo.getvalue()
        
        # Проверяем и обрабатываем изображение
        photo_bytes = ensure_image_requirements(photo_bytes)
        if not photo_bytes:
            await message.answer(
                "⚠️ Ошибка обработки изображения.\n"
                "Убедитесь, что:\n"
                "- Размер файла не превышает 10MB\n"
                "- Формат файла JPEG или PNG\n"
                "- Разрешение не превышает 1024x1024"
            )
            await state.finish()
            return
        
        # Сохраняем фото в состоянии
        async with state.proxy() as data:
            data['original_photo'] = photo_bytes
        
        # Создаем клавиатуру для выбора стиля
        keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
        for style in AVATAR_STYLES.keys():
            keyboard.add(types.KeyboardButton(style))
        
        await UserState.choosing_style.set()
        await message.answer(
            "🎨 Выберите стиль аватара:",
            reply_markup=keyboard
        )
        
    except Exception as e:
        logger.error(f"Error processing photo: {e}")
        await message.answer("Произошла ошибка при обработке фотографии.")
        await state.finish()

@dp.message_handler(state=UserState.choosing_style)
async def handle_style_selection(message: types.Message, state: FSMContext):
    """Обработчик выбора стиля"""
    try:
        style = message.text
        if style not in AVATAR_STYLES:
            await message.answer("Пожалуйста, выберите стиль из предложенных вариантов.")
            return
        
        async with state.proxy() as data:
            data['style'] = style
            
        # Получаем настройки качества
        quality_params = await quality_manager.get_generation_params(
            message.from_user.id,
            AVATAR_STYLES[style].__dict__
        )
        
        # Оцениваем время генерации
        estimated_time = quality_manager._estimate_generation_time(quality_params)
        
        # Начинаем генерацию
        processing_msg = await message.answer(
            f"🎨 Начинаю генерацию в стиле '{style}'...\n"
            f"⏱ Примерное время: {estimated_time} сек."
        )
        
        try:
            # Получаем данные фото
            photo_bytes = data['original_photo']
            
            # Запускаем генерацию
            request_id = await start_generation_with_clothoff(
                photo_bytes,
                quality_params
            )
            
            if not request_id:
                raise Exception("Failed to start generation")
            
            # Сохраняем информацию о генерации
            active_generations[request_id] = {
                "user_id": message.from_user.id,
                "style": style,
                "params": quality_params,
                "progress_message_id": processing_msg.message_id,
                "start_time": datetime.now()
            }
            
            # Обновляем статистику
            await statistics_manager.update_statistics(
                message.from_user.id,
                {
                    'style': style,
                    'params': quality_params,
                    'status': 'started'
                }
            )
            
            await UserState.waiting_for_generation.set()
            async with state.proxy() as data:
                data['current_generation'] = request_id
            
        except Exception as gen_error:
            logger.error(f"Generation error: {gen_error}")
            await message.answer(
                "Произошла ошибка при запуске генерации. "
                "Пожалуйста, попробуйте другой стиль или повторите позже."
            )
            await state.finish()
            return
            
    except Exception as e:
        logger.error(f"Error handling style selection: {e}")
        await message.answer("Произошла ошибка. Пожалуйста, попробуйте позже.")
        await state.finish()

# Функция для начала генерации через Clothoff API
async def start_generation_with_clothoff(
    image_bytes: bytes,
    params: dict
) -> Optional[str]:
    """Начало генерации изображения через Clothoff API"""
    try:
        # Кодируем изображение в base64
        base64_image = base64.b64encode(image_bytes).decode('utf-8')
        
        # Подготавливаем данные для запроса
        payload = {
            "image": base64_image,
            "prompt": params["prompt"],
            "negative_prompt": params.get("negative_prompt", "nude, naked, nsfw, bad quality, blurry, deformed"),
            "guidance_scale": params.get("guidance_scale", 7.5),
            "image_guidance_scale": params.get("image_guidance_scale", 1.3),
            "position": params.get("position", "face"),
            "num_inference_steps": params.get("num_inference_steps", 50),
            "num_outputs": params.get("num_outputs", 1),
            "webhook_url": f"{config.webhook.base_url}{config.webhook.path}",
            "webhook_events": ["completed", "failed", "progress"]
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{config.clothoff.api_url}/image/generate",
                headers={
                    "X-API-Key": config.clothoff.api_key,
                    "Content-Type": "application/json"
                },
                json=payload
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    logger.error(f"Clothoff API error: {error_text}")
                    return None
                
                result = await response.json()
                return result.get("request_id")
                
    except Exception as e:
        logger.error(f"Error in start_generation_with_clothoff: {e}")
        return None

async def handle_webhook(request: web.Request) -> web.Response:
    """Обработчик веб-хуков от Clothoff API"""
    try:
        # Проверяем подпись webhook
        if not await validate_webhook_request(request, config.webhook.secret):
            return WebhookResponse.unauthorized()
        
        data = await request.json()
        request_id = data.get("request_id")
        status = data.get("status")
        event = data.get("event")
        
        if not request_id or request_id not in active_generations:
            logger.warning(f"Received webhook for unknown request_id: {request_id}")
            return WebhookResponse.not_found()
            
        generation_data = active_generations[request_id]
        user_id = generation_data.get("user_id")
        
        if event == "progress":
            # Обновляем прогресс
            progress = data.get("progress", 0)
            await notification_manager.send_progress_notification(
                user_id,
                progress,
                request_id,
                generation_data.get("progress_message_id")
            )
            
        elif event == "completed":
            images_data = data.get("result", {}).get("images", [])
            if not images_data:
                logger.error(f"No images in completed webhook: {data}")
                await notification_manager.send_error_notification(
                    user_id,
                    "Не удалось получить сгенерированные изображения"
                )
                return WebhookResponse.error("No images in result")
                
            try:
                # Декодируем и сохраняем варианты
                image_bytes_list = [base64.b64decode(img) for img in images_data]
                await variants_manager.add_variants(
                    request_id,
                    image_bytes_list,
                    generation_data.get("params", {})
                )
                
                # Создаем медиагруппу для отправки
                media_group = []
                for i, image_bytes in enumerate(image_bytes_list):
                    media_group.append(
                        types.InputMediaPhoto(
                            media=io.BytesIO(image_bytes),
                            caption=f"Вариант {i+1}" if i == 0 else None
                        )
                    )
                
                # Обновляем счетчик изображений
                db.update_images_count(user_id)
                _, images_left = db.check_subscription(user_id)
                
                # Отправляем результаты
                await bot.send_media_group(user_id, media_group)
                await bot.send_message(
                    user_id,
                    f"✨ Осталось изображений: {images_left}"
                )
                
                # Если несколько вариантов, предлагаем сравнить
                if len(media_group) > 1:
                    keyboard = types.InlineKeyboardMarkup()
                    keyboard.add(types.InlineKeyboardButton(
                        "🔍 Сравнить варианты",
                        callback_data=f"compare_{request_id}"
                    ))
                    await bot.send_message(
                        user_id,
                        "Хотите сравнить варианты?",
                        reply_markup=keyboard
                    )
                
                # Обновляем статистику
                await statistics_manager.update_statistics(
                    user_id,
                    {
                        'style': generation_data['style'],
                        'params': generation_data['params'],
                        'status': 'success'
                    }
                )
                
            except Exception as e:
                logger.error(f"Error processing completed webhook: {e}")
                await notification_manager.send_error_notification(
                    user_id,
                    "Произошла ошибка при обработке результатов"
                )
                
        elif event == "failed":
            error_info = data.get("error", {})
            error_message = error_info.get("message", "Неизвестная ошибка")
            
            await notification_manager.send_error_notification(
                user_id,
                error_message,
                retry_allowed=True
            )
            
            # Обновляем статистику
            await statistics_manager.update_statistics(
                user_id,
                {
                    'style': generation_data['style'],
                    'params': generation_data['params'],
                    'status': 'failed',
                    'error': error_message
                }
            )
            
        if status in ["completed", "failed"]:
            # Очищаем данные о генерации
            variants_manager.cleanup_variants(request_id)
            del active_generations[request_id]
        
        return WebhookResponse.success()
        
    except Exception as e:
        logger.error(f"Error in webhook handler: {e}")
        return WebhookResponse.server_error()

@dp.callback_query_handler(lambda c: c.data.startswith('compare_'))
async def handle_comparison_request(callback_query: types.CallbackQuery):
    """Обработка запроса на сравнение вариантов"""
    try:
        request_id = callback_query.data.replace('compare_', '')
        
        # Создаем сетку для сравнения
        comparison_image = await variants_manager.create_comparison_grid(request_id)
        if not comparison_image:
            await callback_query.answer("Варианты больше недоступны")
            return
            
        # Отправляем сравнительную сетку
        await bot.send_photo(
            callback_query.from_user.id,
            comparison_image,
            caption="Сравнение вариантов:"
        )
        
        await callback_query.answer()
        
    except Exception as e:
        logger.error(f"Error handling comparison request: {e}")
        await callback_query.answer("Произошла ошибка при создании сравнения")

@dp.message_handler(commands=['stats'])
async def show_statistics(message: types.Message):
    """Показ статистики пользователя"""
    try:
        stats = await statistics_manager.get_user_statistics(message.from_user.id)
        
        # Форматируем статистику
        stats_message = (
            "📊 Ваша статистика:\n\n"
            f"Всего генераций: {stats['total_generations']}\n"
            f"Успешных: {stats['successful_generations']}\n"
            f"Процент успеха: {stats['success_rate']:.1f}%\n\n"
            "🎨 Популярные стили:\n"
        )
        
        # Добавляем статистику по стилям
        for style, count in sorted(
            stats['style_statistics'].items(),
            key=lambda x: x[1],
            reverse=True
        )[:5]:
            percentage = count / stats['total_generations'] * 100
            stats_message += f"- {style}: {count} ({percentage:.1f}%)\n"
        
        await message.answer(stats_message)
        
    except Exception as e:
        logger.error(f"Error showing statistics: {e}")
        await message.answer("Произошла ошибка при получении статистики")

@dp.message_handler(commands=['quality'])
async def show_quality_settings(message: types.Message):
    """Показ настроек качества"""
    try:
        presets = await quality_manager.get_available_presets()
        
        keyboard = types.InlineKeyboardMarkup(row_width=1)
        for preset_name, preset_info in presets.items():
            keyboard.add(types.InlineKeyboardButton(
                f"{preset_info['name'].title()} "
                f"({preset_info['steps']} шагов, ~{preset_info['estimated_time']} сек.)",
                callback_data=f"set_quality_{preset_name}"
            ))
        
        await message.answer(
            "⚙️ Настройки качества генерации:\n"
            "Выберите предпочитаемый баланс скорости и качества:",
            reply_markup=keyboard
        )
        
    except Exception as e:
        logger.error(f"Error showing quality settings: {e}")
        await message.answer("Произошла ошибка при получении настроек качества")

@dp.message_handler(commands=['help'])
async def show_help(message: types.Message):
    """Показ справки"""
    help_text = """
🤖 Доступные команды:

/start - Начать работу с ботом
/quality - Настройка качества генерации
/stats - Ваша статистика использования
/help - Эта справка

🎨 Доступные стили:
"""
    
    for style in AVATAR_STYLES:
        help_text += f"• {style}\n"
        
    help_text += """
💡 Советы:
• Используйте фото с хорошим освещением
• Выбирайте высокое качество для важных генераций
• Сравнивайте варианты перед сохранением
"""
    
    await message.answer(help_text)

async def on_startup(app: web.Application):
    """Действия при запуске"""
    # Инициализация бота
    await bot.set_webhook(f"{config.webhook.base_url}{config.webhook.path}")
    
    # Настройка маршрутов для вебхуков
    await setup_webhook_routes(app, handle_webhook)
    
    logger.info(f"Bot @{(await bot.me).username} started")

def setup_app() -> web.Application:
    """Настройка веб-приложения"""
    app = web.Application()
    app.on_startup.append(on_startup)
    return app

async def cleanup():
    """Очистка при завершении"""
    session = aiohttp.ClientSession()
    await session.close()

def main():
    """Запуск бота"""
    # Создаем приложение
    app = setup_app()
    
    # Запускаем веб-сервер для вебхуков
    web.run_app(
        app,
        host=config.webhook.host,
        port=config.webhook.port,
        shutdown_timeout=60,
    )

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        logger.error(f"Error in main: {e}")
    finally:
        asyncio.run(cleanup())