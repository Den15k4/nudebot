from typing import Dict, Any
from dataclasses import dataclass
import logging
from ..styles import QUALITY_PRESETS

logger = logging.getLogger(__name__)

@dataclass
class QualityPreset:
    name: str
    steps: int
    guidance_scale: float
    image_guidance_scale: float
    estimated_time: int

class QualityManager:
    """Управление качеством генерации"""
    
    def __init__(self, db):
        self.db = db
        self.presets = self._init_presets()
    
    def _init_presets(self) -> Dict[str, QualityPreset]:
        presets = {}
        for name, config in QUALITY_PRESETS.items():
            presets[name] = QualityPreset(
                name=name,
                steps=config['num_inference_steps'],
                guidance_scale=config['guidance_scale'],
                image_guidance_scale=config['image_guidance_scale'],
                estimated_time=self._estimate_generation_time(config)
            )
        return presets
    
    def _estimate_generation_time(self, config: dict) -> int:
        """Оценка времени генерации в секундах"""
        steps = config['num_inference_steps']
        base_time = 15  # базовое время в секундах
        time_per_step = 0.3  # время на один шаг
        return int(base_time + steps * time_per_step)
    
    async def get_generation_params(self, user_id: int, base_params: dict) -> dict:
        """Получение параметров генерации с учетом настроек качества"""
        try:
            user = self.db.get_user(user_id)
            if not user or not user.settings:
                preset_name = "balanced"
            else:
                preset_name = user.settings.get("quality_preset", "balanced")
            
            preset = self.presets.get(preset_name)
            if not preset:
                preset = self.presets["balanced"]
            
            # Объединяем базовые параметры с пресетом качества
            params = base_params.copy()
            params.update({
                "num_inference_steps": preset.steps,
                "guidance_scale": preset.guidance_scale,
                "image_guidance_scale": preset.image_guidance_scale
            })
            
            return params
            
        except Exception as e:
            logger.error(f"Error getting generation params: {e}")
            return base_params
    
    async def get_available_presets(self) -> Dict[str, Dict[str, Any]]:
        """Получение списка доступных пресетов с описанием"""
        return {
            name: {
                "name": preset.name,
                "steps": preset.steps,
                "estimated_time": preset.estimated_time,
                "description": self._get_preset_description(name)
            }
            for name, preset in self.presets.items()
        }
    
    def _get_preset_description(self, preset_name: str) -> str:
        """Получение описания пресета"""
        descriptions = {
            "fast": "Быстрая генерация с базовым качеством",
            "balanced": "Оптимальный баланс скорости и качества",
            "high": "Максимальное качество с увеличенным временем генерации"
        }
        return descriptions.get(preset_name, "")
    
    async def update_user_quality_preset(self, user_id: int, preset_name: str) -> bool:
        """Обновление пресета качества для пользователя"""
        if preset_name not in self.presets:
            return False
        
        try:
            return self.db.update_user_settings(user_id, {
                "quality_preset": preset_name
            })
        except Exception as e:
            logger.error(f"Error updating user quality preset: {e}")
            return False
