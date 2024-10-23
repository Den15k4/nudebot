import logging
import asyncio
from aiogram import Bot, Dispatcher, types, executor
from aiogram.contrib.fsm_storage.memory import MemoryStorage
from aiogram.dispatcher import FSMContext
from aiogram.dispatcher.filters.state import State, StatesGroup
from config import load_config
from database import Database
from styles import AVATAR_STYLES
import stability_sdk.interfaces.gooseai.generation.generation_pb2 as generation
from stability_sdk import client
import io
from PIL import Image

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

# Инициализация Stability API
stability_api = client.StabilityInference(
    key=config.STABILITY_KEY,
    verbose=True,
    engine="stable-diffusion-xl-1024-v1-0"
)

class UserState(StatesGroup):
    waiting_for_photo = State()
    choosing_style = State()

@dp.message_handler(commands=['start'])
async def cmd_start(message: types.Message):
    """Обработчик команды /start"""
    try:
        logger.info(f"Processing /start command from user {message.from_user.id}")
        
        keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
        keyboard.add(types.KeyboardButton("Создать аватар"))
        
        # Регистрируем пользователя
        try:
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
        for style in AVATAR_STYLES.keys():
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
        if style not in AVATAR_STYLES:
            await message.answer("Пожалуйста, выберите стиль из предложенных вариантов.")
            return
        
        async with state.proxy() as data:
            photo_bytes = data['original_photo']
        
        processing_msg = await message.answer("Генерирую аватар... Это может занять около минуты.")
        
        # Подготовка изображения
        image = Image.open(io.BytesIO(photo_bytes))
        width, height = image.size
        new_size = 1024
        ratio = min(new_size/width, new_size/height)
        new_width = int(width * ratio)
        new_height = int(height * ratio)
        image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
        
        try:
            logger.info(f"Starting image generation for user {message.from_user.id} with style {style}")
            
            # Генерация изображения
            answers = stability_api.generate(
                prompt=AVATAR_STYLES[style],
                init_image=image,
                start_schedule=0.95,
                seed=123,
                steps=50,
                cfg_scale=5.0,
                width=1024,
                height=1024,
                samples=1
            )
            
            logger.info("Generation completed, processing results")
            
            # Обработка результата
            for resp in answers:
                for artifact in resp.artifacts:
                    if artifact.type == generation.ARTIFACT_IMAGE:
                        img_bytes = io.BytesIO(artifact.binary)
                        
                        # Обновляем счетчик изображений
                        db.update_images_count(message.from_user.id)
                        has_sub, images_left = db.check_subscription(message.from_user.id)
                        
                        # Отправляем результат
                        await message.answer_photo(
                            img_bytes,
                            caption=f"Вот ваш аватар в стиле '{style}'!\nОсталось изображений: {images_left}"
                        )
                        logger.info(f"Successfully sent generated image to user {message.from_user.id}")
            
        except Exception as gen_error:
            logger.error(f"Stability AI error: {gen_error}")
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

def main():
    logger.info("Starting bot")
    executor.start_polling(dp, skip_updates=True)

if __name__ == '__main__':
    main()