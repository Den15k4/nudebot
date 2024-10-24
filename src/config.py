import os
from dataclasses import dataclass
from typing import Optional

@dataclass
class DatabaseConfig:
    url: str

@dataclass
class TelegramConfig:
    token: str

@dataclass
class ClothoffConfig:
    api_key: str
    api_url: str = "https://api.clothoff.app/v1"

@dataclass
class WebhookConfig:
    base_url: str
    host: str
    port: int
    path: str = "/webhook"

@dataclass
class RedisConfig:
    url: Optional[str]
    enabled: bool = False

@dataclass
class Config:
    db: DatabaseConfig
    telegram: TelegramConfig
    clothoff: ClothoffConfig
    webhook: WebhookConfig
    redis: RedisConfig
    debug: bool = False

def load_config() -> Config:
    return Config(
        db=DatabaseConfig(
            url=os.getenv("DATABASE_URL")
        ),
        telegram=TelegramConfig(
            token=os.getenv("BOT_TOKEN")
        ),
        clothoff=ClothoffConfig(
            api_key=os.getenv("CLOTHOFF_KEY"),
            api_url=os.getenv("CLOTHOFF_API_URL", "https://api.clothoff.app/v1")
        ),
        webhook=WebhookConfig(
            base_url=os.getenv("WEBHOOK_BASE_URL"),
            host=os.getenv("WEBHOOK_HOST", "0.0.0.0"),
            port=int(os.getenv("WEBHOOK_PORT", "8080"))
        ),
        redis=RedisConfig(
            url=os.getenv("REDIS_URL"),
            enabled=bool(os.getenv("REDIS_ENABLED", False))
        ),
        debug=bool(os.getenv("DEBUG", False))
    )
