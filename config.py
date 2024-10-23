import os
from dataclasses import dataclass

@dataclass
class Config:
    BOT_TOKEN: str
    STABILITY_KEY: str
    DATABASE_URL: str

def load_config() -> Config:
    return Config(
        BOT_TOKEN=os.getenv('BOT_TOKEN'),
        STABILITY_KEY=os.getenv('STABILITY_KEY'),
        DATABASE_URL=os.getenv('DATABASE_URL')
    )
