from typing import Optional
import logging
from datetime import datetime
from aiogram import Bot
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

logger = logging.getLogger(__name__)

class NotificationManager:
    """Управление уведомлениями"""
    
    def __init__(self, bot: Bot, db):
        self.bot = bot
        self.db = db
    
    async def send_progress_notification(
        self,
        user_id: int,
        progress: int,
        request_id: str,
        message_id: Optional[int] = None
    ) -> None:
        """Отправка/обновление уведомления о прогрессе"""
        try:
            user = self.db.get_user(user_id)
            if not user or not user.settings.get("notifications_enabled", True):
                return
            
            estimated_time = await self._get_remaining_time(request_id, progress)
            message = f"🔄 Генерация аватара... {progress}%"
            
            if estimated_time:
                message += f"\n⏱ Осталось примерно {estimated_time} мин."
            
            if message_id:
                try:
                    await self.bot.edit_message_text(
                        message,
                        chat_id=user_id,
                        message_id=message_id
                    )
                except Exception as e:
                    logger.error(f"Error updating progress message: {e}")
            else:
                await self.bot.send_message(user_id, message)
                
        except Exception as e:
            logger.error(f"Error sending progress notification: {e}")
    
    async def send_completion_notification(
        self,
        user_id: int,
        request_id: str,
        num_variants: int = 1
    ) -> None:
        """Отправка уведомления о завершении генерации"""
        try:
            user = self.db.get_user(user_id)
            if not user or not user.settings.get("notifications_enabled", True):
                return
            
            keyboard = InlineKeyboardMarkup()
            keyboard.add(InlineKeyboardButton(
                "🖼 Посмотреть результат",
                callback_data=f"view_result_{request_id}"
            ))
            
            if num_variants > 1:
                keyboard.add(InlineKeyboardButton(
                    "🔍 Сравнить варианты",
                    callback_data=f"compare_variants_{request_id}"
                ))
            
            await self.bot.send_message(
                user_id,
                "✨ Генерация аватара завершена!",
                reply_markup=keyboard
            )
            
        except Exception as e:
            logger.error(f"Error sending completion notification: {e}")
    
    async def send_error_notification(
        self,
        user_id: int,
        error_message: str,
        retry_allowed: bool = True
    ) -> None:
        """Отправка уведомления об ошибке"""
        try:
            user = self.db.get_user(user_id)
            if not user or not user.settings.get("notifications_enabled", True):
                return
            
            message = f"❌ Произошла ошибка при генерации:\n{error_message}"
            
            keyboard = InlineKeyboardMarkup()
            if retry_allowed:
                keyboard.add(InlineKeyboardButton(
                    "🔄 Повторить",
                    callback_data="retry_generation"
                ))
            
            await self.bot.send_message(
                user_id,
                message,
                reply_markup=keyboard if retry_allowed else None
            )
            
        except Exception as e:
            logger.error(f"Error sending error notification: {e}")
    
    async def _get_remaining_time(self, request_id: str, progress: int) -> Optional[int]:
        """Расчет оставшегося времени"""
        if progress <= 0:
            return None
            
        generation = self.db.get_generation_by_request_id(request_id)
        if not generation:
            return None
            
        elapsed_time = (datetime.now() - generation.created_at).total_seconds() / 60
        estimated_total = elapsed_time * (100 / progress)
        
        return round(estimated_total - elapsed_time)
