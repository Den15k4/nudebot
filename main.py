import logging
import asyncio
from aiogram import Bot, Dispatcher, types, executor
from aiogram.contrib.fsm_storage.memory import MemoryStorage
from aiogram.dispatcher import FSMContext
from aiogram.dispatcher.filters.state import State, StatesGroup
from config import load_config
from database import Database
from sqlalchemy import inspect  # Добавляем импорт inspect
import replicate
import io
from PIL import Image
import aiohttp
from datetime import datetime
import traceback

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Загрузка конфигурации
config = load_config()

# Инициализация бота
bot = Bot(token=config.BOT_TOKEN)
storage = MemoryStorage()
dp = Dispatcher(bot, storage=storage)

# Инициализация базы данных
db = Database(config.DATABASE_URL)

# Инициализация Replicate клиента
replicate_client = replicate.Client(api_token=config.REPLICATE_TOKEN)

# Стили и промпты
STYLES = {
    "космонавт": {
        "prompt": (
            "change ONLY the clothes to a detailed white NASA spacesuit with helmet, "
            "keep face EXACTLY the same, keep hair EXACTLY the same, "
            "keep background EXACTLY the same, maintain facial expression, maintain pose, "
            "photorealistic, detailed, high quality"
        ),
        "negative_prompt": (
            "different face, changed face, modified features, different person, "
            "deformed, distorted, cartoon, artistic, painting, drawing, anime, "
            "different hairstyle, different expression"
        )
    },
    "киберпанк": {
        "prompt": (
            "change ONLY the clothes to futuristic cyberpunk outfit with neon accents, "
            "keep face EXACTLY the same, keep hair EXACTLY the same, "
            "keep background EXACTLY the same, maintain facial expression, maintain pose, "
            "photorealistic, detailed, high quality"
        ),
        "negative_prompt": (
            "different face, changed face, modified features, different person, "
            "deformed, distorted, cartoon, artistic, painting, drawing, anime, "
            "different hairstyle, different expression"
        )
    },
    "супергерой": {
        "prompt": (
            "change ONLY the clothes to modern superhero costume with subtle details, "
            "keep face EXACTLY the same, keep hair EXACTLY the same, "
            "keep background EXACTLY the same, maintain facial expression, maintain pose, "
            "photorealistic, detailed, high quality"
        ),
        "negative_prompt": (
            "different face, changed face, modified features, different person, "
            "deformed, distorted, cartoon, artistic, painting, drawing, anime, "
            "different hairstyle, different expression"
        )
    }
}

class UserState(StatesGroup):
    waiting_for_photo = State()
    choosing_style = State()

def prepare_image(image_bytes: bytes) -> bytes:
    """Подготовка изображения перед обработкой"""
    try:
        # Открываем изображение
        image = Image.open(io.BytesIO(image_bytes))
        
        # Конвертируем в RGB если нужно
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Изменяем размер, сохраняя пропорции
        max_size = 1024
        ratio = min(max_size/image.size[0], max_size/image.size[1])
        new_size = (int(image.size[0]*ratio), int(image.size[1]*ratio))
        image = image.resize(new_size, Image.Resampling.LANCZOS)
        
        # Сохраняем в bytes
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        buffer.seek(0)
        
        return buffer.getvalue()
    except Exception as e:
        logger.error(f"Error preparing image: {e}")
        raise

async def process_image_with_replicate(image_bytes: bytes, style: str) -> bytes:
    """Обработка изображения через Replicate API"""
    try:
        # Подготавливаем изображение
        prepared_image = prepare_image(image_bytes)
        
        logger.info(f"Starting image processing with style: {style}")
        
        # Запускаем модель
        output = replicate_client.run(
            "timothybrooks/instruct-pix2pix:30c1d0b916a6f8efce20493f5d61ee27491ab2a60437c13c588468b9810ec23f",
            input={
                "image": prepared_image,
                "prompt": STYLES[style]["prompt"],
                "negative_prompt": STYLES[style]["negative_prompt"],
                "num_outputs": 1,
                "guidance_scale": 7.5,
                "image_guidance_scale": 1.5,
                "steps": 100
            }
        )
        
        logger.info("Image processing completed")
        
        # Получаем результат
        if isinstance(output, list) and len(output) > 0:
            image_url = output[0]
            async with aiohttp.ClientSession() as session:
                async with session.get(image_url) as response:
                    if response.status == 200:
                        return await response.read()
        
        raise ValueError("Failed to get valid output from Replicate")
    
    except Exception as e:
        logger.error(f"Error in process_image_with_replicate: {e}\n{traceback.format_exc()}")
        raise

@dp.message_handler(commands=['start'])
async def cmd_start(message: types.Message):
    """Обработчик команды /start"""
    try:
        logger.info(f"Processing /start command from user {message.from_user.id}")
        
        keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
        keyboard.add(types.KeyboardButton("Создать аватар"))
        
        try:
            # Регистрируем пользователя
            db.register_user(message.from_user.id, message.from_user.username)
            has_sub, images_left = db.check_subscription(message.from_user.id)
            
            await message.answer(
                "👋 Привет! Я бот для создания стильных аватаров.\n"
                "Нажмите 'Создать аватар' чтобы начать!",
                reply_markup=keyboard
            )
            
            await message.answer(f"У вас осталось изображений: {images_left}")
            
        except Exception as db_error:
            logger.error(f"Database error in start command: {db_error}")
            await message.answer(
                "Произошла ошибка при проверке подписки. "
                "Пожалуйста, попробуйте позже.",
                reply_markup=keyboard
            )
            
    except Exception as e:
        logger.error(f"Error in start command: {e}")
        await message.answer(
            "Произошла ошибка. Пожалуйста, попробуйте позже."
        )

@dp.message_handler(text="Создать аватар")
async def request_photo(message: types.Message):
    """Обработчик кнопки Создать аватар"""
    try:
        has_sub, images_left = db.check_subscription(message.from_user.id)
        
        if images_left <= 0:
            await message.answer("У вас закончились доступные изображения!")
            return
        
        await UserState.waiting_for_photo.set()
        await message.answer(f"Отправьте фотографию. У вас осталось изображений: {images_left}")
        
    except Exception as e:
        logger.error(f"Error in request_photo: {e}")
        await message.answer("Произошла ошибка. Пожалуйста, попробуйте позже.")

@dp.message_handler(content_types=['photo'], state=UserState.waiting_for_photo)
async def process_photo(message: types.Message, state: FSMContext):
    """Обработчик полученной фотографии"""
    try:
        photo = await message.photo[-1].download(destination_file=io.BytesIO())
        
        async with state.proxy() as data:
            data['original_photo'] = photo.getvalue()
        
        keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
        for style in STYLES.keys():
            keyboard.add(types.KeyboardButton(style))
        
        await UserState.choosing_style.set()
        await message.answer("Выберите стиль аватара:", reply_markup=keyboard)
        
    except Exception as e:
        logger.error(f"Error processing photo: {e}")
        await message.answer("Произошла ошибка при обработке фотографии.")
        await state.finish()

@dp.message_handler(state=UserState.choosing_style)
async def generate_avatar(message: types.Message, state: FSMContext):
    """Генерация аватара в выбранном стиле"""
    try:
        style = message.text
        if style not in STYLES:
            await message.answer("Пожалуйста, выберите стиль из предложенных вариантов.")
            return
        
        async with state.proxy() as data:
            photo_bytes = data['original_photo']
        
        processing_msg = await message.answer("Генерирую аватар... Это может занять около минуты.")
        
        try:
            # Обработка изображения
            result_bytes = await process_image_with_replicate(photo_bytes, style)
            
            # Обновляем счетчик изображений
            db.update_images_count(message.from_user.id)
            has_sub, images_left = db.check_subscription(message.from_user.id)
            
            # Отправляем результат
            await message.answer_photo(
                result_bytes,
                caption=f"Вот ваш аватар в стиле '{style}'!\nОсталось изображений: {images_left}"
            )
            
        except Exception as gen_error:
            logger.error(f"Generation error: {gen_error}")
            await message.answer(
                "Произошла ошибка при генерации изображения. "
                "Пожалуйста, попробуйте другой стиль или повторите позже."
            )
            return
            
        finally:
            try:
                await processing_msg.delete()
            except Exception as e:
                logger.error(f"Error deleting processing message: {e}")
        
    except Exception as e:
        logger.error(f"Error generating avatar: {e}")
        await message.answer(
            "Произошла ошибка при генерации аватара. "
            "Пожалуйста, попробуйте позже."
        )
    finally:
        await state.finish()
        keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
        keyboard.add(types.KeyboardButton("Создать аватар"))
        await message.answer("Хотите создать ещё один аватар?", reply_markup=keyboard)

@dp.message_handler(content_types=types.ContentType.ANY)
async def unknown_message(message: types.Message):
    """Обработчик неизвестных сообщений"""
    keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
    keyboard.add(types.KeyboardButton("Создать аватар"))
    await message.answer(
        "Я вас не понимаю. Нажмите 'Создать аватар' чтобы начать!",
        reply_markup=keyboard
    )

async def on_startup(dp: Dispatcher):
    """Действия при запуске бота"""
    logger.info("Bot starting...")
    try:
        # Проверка подключения к базе данных
        logger.info("Checking database connection...")
        inspector = inspect(db.engine)
        tables = inspector.get_table_names()
        logger.info(f"Connected to database. Available tables: {tables}")
        
        logger.info("Bot started successfully")
        
    except Exception as e:
        logger.error(f"Error during startup: {e}")
        raise
    
    logger.info("Bot started successfully")

def main():
    """Запуск бота"""
    logger.info("Starting bot")
    executor.start_polling(dp, skip_updates=True, on_startup=on_startup)

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        logger.error(f"Critical error: {e}\n{traceback.format_exc()}")
        raise