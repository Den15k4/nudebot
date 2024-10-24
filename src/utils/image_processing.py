import io
from PIL import Image
from typing import Optional
import logging

logger = logging.getLogger(__name__)

def ensure_image_requirements(image_bytes: bytes) -> Optional[bytes]:
    """Проверка и корректировка изображения под требования API"""
    try:
        image = Image.open(io.BytesIO(image_bytes))
        
        # Проверяем формат
        if image.format not in ['JPEG', 'PNG']:
            # Конвертируем в PNG
            img_byte_arr = io.BytesIO()
            image.save(img_byte_arr, format='PNG')
            image_bytes = img_byte_arr.getvalue()
        
        # Проверяем размеры
        width, height = image.size
        max_size = 1024
        if width > max_size or height > max_size:
            ratio = min(max_size/width, max_size/height)
            new_width = int(width * ratio)
            new_height = int(height * ratio)
            image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            
            img_byte_arr = io.BytesIO()
            image.save(img_byte_arr, format='PNG')
            image_bytes = img_byte_arr.getvalue()
            
        # Проверяем размер файла (максимум 10MB)
        if len(image_bytes) > 10 * 1024 * 1024:
            return None
            
        return image_bytes
    except Exception as e:
        logger.error(f"Error in ensure_image_requirements: {e}")
        return None

def create_image_grid(images: list, rows: int = None, cols: int = None) -> bytes:
    """Создание сетки изображений"""
    if not images:
        return None
        
    n = len(images)
    if not rows and not cols:
        cols = 2
        rows = (n + 1) // 2
    
    if not cols:
        cols = (n + rows - 1) // rows
    if not rows:
        rows = (n + cols - 1) // cols
        
    cell_width = cell_height = 512
    grid = Image.new('RGB', (cols * cell_width, rows * cell_height))
    
    for idx, image_bytes in enumerate(images):
        if idx >= rows * cols:
            break
            
        try:
            img = Image.open(io.BytesIO(image_bytes))
            img = img.resize((cell_width, cell_height), Image.Resampling.LANCZOS)
            
            x = (idx % cols) * cell_width
            y = (idx // cols) * cell_height
            grid.paste(img, (x, y))
            
        except Exception as e:
            logger.error(f"Error processing image {idx} for grid: {e}")
            continue
    
    output = io.BytesIO()
    grid.save(output, format='JPEG', quality=95)
    return output.getvalue()
