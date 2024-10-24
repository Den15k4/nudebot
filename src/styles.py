from dataclasses import dataclass
from typing import Dict

@dataclass
class StyleConfig:
    prompt: str
    image_guidance_scale: float
    position: str
    negative_prompt: str = "nude, naked, nsfw, bad quality, blurry, deformed, unrealistic"
    guidance_scale: float = 7.5
    num_inference_steps: int = 50

AVATAR_STYLES: Dict[str, StyleConfig] = {
    "космонавт": StyleConfig(
        prompt="professional portrait photograph of the same person as an astronaut, wearing astronaut helmet, epic lighting, cinematic composition, 8k uhd, highly detailed, photorealistic",
        image_guidance_scale=1.5,
        position="face"
    ),
    "киберпанк": StyleConfig(
        prompt="professional portrait of the same person, cyberpunk style, neon city background, moody lighting, highly detailed, vibrant neon accents, cinematic quality, 8k uhd, photorealistic",
        image_guidance_scale=1.2,
        position="full"
    ),
    "супергерой": StyleConfig(
        prompt="professional portrait of the same person as a superhero, dynamic lighting, city background, dramatic atmosphere, detailed costume design, cinematic quality, 8k uhd, photorealistic",
        image_guidance_scale=1.3,
        position="upper_body"
    )
}

# Константы для API
POSITIONS = [
    ("face", "Только лицо"),
    ("upper_body", "Верхняя часть тела"),
    ("full", "Полное изображение")
]

QUALITY_PRESETS = {
    "fast": {
        "num_inference_steps": 30,
        "guidance_scale": 7.0,
        "image_guidance_scale": 1.2
    },
    "balanced": {
        "num_inference_steps": 50,
        "guidance_scale": 7.5,
        "image_guidance_scale": 1.3
    },
    "high": {
        "num_inference_steps": 75,
        "guidance_scale": 8.0,
        "image_guidance_scale": 1.5
    }
}
