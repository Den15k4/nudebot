from typing import Dict, List, Optional
from dataclasses import dataclass
import io
from datetime import datetime, timedelta
from PIL import Image
import logging

logger = logging.getLogger(__name__)

@dataclass
class GenerationResult:
    image_bytes: bytes
    params: dict
    score: float = 0.0
    created_at: datetime = datetime.now()

class VariantsManager:
    """Управление вариантами генерации"""
    
    def __init__(self):
        self._variants: Dict[str, List[GenerationResult]] = {}
        self._cleanup_threshold = timedelta(hours=1)
    
    async def add_variants(self, request_id: str, variants: List[bytes], params: dict) -> None:
        """Добавление новых вариантов"""
        if request_id not in self._variants:
            self._variants[request_id] = []
            
        for variant in variants:
            self._variants[request_id].append(
                GenerationResult(
                    image_bytes=variant,
                    params=params
                )
            )
        
        # Запускаем очистку старых вариантов
        await self._cleanup_old_variants()
    
    async def get_variants(self, request_id: str) -> Optional[List[GenerationResult]]:
        """Получение всех вариантов для запроса"""
        return self._variants.get(request_id)
    
    async def get_variant(self, request_id: str, index: int) -> Optional[GenerationResult]:
        """Получение конкретного варианта"""
        variants = self._variants.get(request_id)
        if variants and 0 <= index < len(variants):
            return variants[index]
        return None
    
    async def update_variant_score(self, request_id: str, index: int, score: float) -> bool:
        """Обновление оценки варианта"""
        variant = await self.get_variant(request_id, index)
        if variant:
            variant.score = score
            return True
        return False
    
    async def get_best_variant(self, request_id: str) -> Optional[GenerationResult]:
        """Получение варианта с лучшей оценкой"""
        variants = self._variants.get(request_id)
        if not variants:
            return None
        return max(variants, key=lambda x: x.score)
    
    async def create_comparison_grid(self, request_id: str) -> Optional[bytes]:
        """Создание сетки для сравнения вариантов"""
        variants = self._variants.get(request_id)
        if not variants:
            return None
            
        images = []
        for variant in variants:
            try:
                img = Image.open(io.BytesIO(variant.image_bytes))
                images.append(img)
            except Exception as e:
                logger.error(f"Error processing image for grid: {e}")
                continue
        
        if not images:
            return None
            
        # Определяем размеры сетки
        n = len(images)
        cols = min(3, n)
        rows = (n + cols - 1) // cols
        
        # Создаем сетку
        cell_size = 512
        grid = Image.new('RGB', (cols * cell_size, rows * cell_size))
        
        for idx, img in enumerate(images):
            x = (idx % cols) * cell_size
            y = (idx // cols) * cell_size
            
            img = img.resize((cell_size, cell_size))
            grid.paste(img, (x, y))
        
        output = io.BytesIO()
        grid.save(output, format='JPEG', quality=95)
        return output.getvalue()
    
    def cleanup_variants(self, request_id: str) -> None:
        """Очистка вариантов по request_id"""
        if request_id in self._variants:
            del self._variants[request_id]
    
    async def _cleanup_old_variants(self) -> None:
        """Очистка старых вариантов"""
        current_time = datetime.now()
        to_remove = []
        
        for request_id, variants in self._variants.items():
            if variants and (current_time - variants[0].created_at) > self._cleanup_threshold:
                to_remove.append(request_id)
        
        for request_id in to_remove:
            self.cleanup_variants(request_id)
