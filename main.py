import logging
import asyncio
from aiogram import Bot, Dispatcher, types
from aiogram.contrib.fsm_storage.memory import MemoryStorage
from aiogram.dispatcher import FSMContext
from aiogram.dispatcher.filters.state import State, StatesGroup
from config import load_config
from database import Database
import stability_sdk.interfaces.gooseai.generation.generation_pb2 as generation
from stability_sdk import client
import io
from PIL import Image

# Настройка логирования
logging.basicConfig(level=logging.INFO)

# Загрузка конфигурации
config = load_config()

# Инициализация бота
bot = Bot(token=config.BOT_TOKEN)
storage = MemoryStorage()
dp = Dispatcher(bot, storage=storage)

# Инициализация базы данных
db = Database(config.DATABASE_URL or 'bot_database.db')

# Важно: инициализируем базу данных перед использованием
db.init_db()

# Инициализация Stability API
stability_api = client.StabilityInference(
    key=config.STABILITY_KEY,
    verbose=True,
)

class UserState(StatesGroup):
    waiting_for_photo = State()
    choosing_style = State()

# Стили аватаров
AVATAR_STYLES = {
    "космонавт": "same person wearing a detailed space suit, astronaut helmet, space background, highly detailed, professional photo",
    "киберпанк": "same person in cyberpunk style, neon lights, futuristic city background, highly detailed",
    "супергерой": "same person as a superhero, dynamic pose, city background, comic book style, highly detailed"
}

@dp.message_handler(commands=['start'])
async def cmd_start(message: types.Message):
    has_sub, images_left = db.check_subscription(message.from_user.id)
    
    keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
    keyboard.add(types.KeyboardButton("Создать аватар"))
    
    await message.answer(
        f"Привет! Я бот для создания стильных аватаров.\n"
        f"У вас осталось изображений: {images_left}\n"
        "Нажмите 'Создать аватар' чтобы начать!",
        reply_markup=keyboard
    )

@dp.message_handler(text="Создать аватар")
async def request_photo(message: types.Message):
    has_sub, images_left = db.check_subscription(message.from_user.id)
    
    if images_left <= 0:
        await message.answer("У вас закончились доступные изображения!")
        return
    
    await UserState.waiting_for_photo.set()
    await message.answer(f"Отправьте фотографию. У вас осталось изображений: {images_left}")

@dp.message_handler(content_types=['photo'], state=UserState.waiting_for_photo)
async def process_photo(message: types.Message, state: FSMContext):
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
        logging.error(f"Error processing photo: {e}")
        await message.answer("Произошла ошибка при обработке фотографии.")
        await state.finish()

@dp.message_handler(state=UserState.choosing_style)
async def generate_avatar(message: types.Message, state: FSMContext):
    style = message.text
    if style not in AVATAR_STYLES:
        await message.answer("Пожалуйста, выберите стиль из предложенных вариантов.")
        return
    
    try:
        async with state.proxy() as data:
            photo_bytes = data['original_photo']
        
        processing_msg = await message.answer("Генерирую аватар... Это может занять около минуты.")
        
        # Преобразуем фото для Stability API
        image = Image.open(io.BytesIO(photo_bytes))
        image = image.resize((512, 512))
        
        # Генерируем аватар
        answers = stability_api.generate(
            prompt=AVATAR_STYLES[style],
            init_image=image,
            start_schedule=0.6,
            seed=123,
            steps=30,
            cfg_scale=8.0,
            width=512,
            height=512,
            samples=1,
        )
        
        # Обрабатываем результат
        for resp in answers:
            for artifact in resp.artifacts:
                if artifact.type == generation.ARTIFACT_IMAGE:
                    img_bytes = io.BytesIO(artifact.binary)
                    
                    # Уменьшаем счетчик доступных изображений
                    db.update_images_count(message.from_user.id)
                    has_sub, images_left = db.check_subscription(message.from_user.id)
                    
                    # Отправляем результат
                    await message.answer_photo(
                        img_bytes,
                        caption=f"Вот ваш аватар в стиле '{style}'!\nОсталось изображений: {images_left}"
                    )
        
        await processing_msg.delete()
        
    except Exception as e:
        logging.error(f"Error generating avatar: {e}")
        await message.answer("Произошла ошибка при генерации аватара.")
    finally:
        await state.finish()
        keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
        keyboard.add(types.KeyboardButton("Создать аватар"))
        await message.answer("Хотите создать ещё один аватар?", reply_markup=keyboard)

if __name__ == '__main__':
    from aiogram import executor
    executor.start_polling(dp, skip_updates=True)
async def on_startup(_):
    """Действия при запуске бота"""
    logging.info("Инициализация базы данных...")
    db.init_db()  # Повторная инициализация при запуске для надежности
    logging.info("База данных инициализирована")

if __name__ == '__main__':
    from aiogram import executor
    
    # Запускаем бота с обработчиком запуска
    executor.start_polling(dp, skip_updates=True, on_startup=on_startup)