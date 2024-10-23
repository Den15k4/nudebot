import os
from dataclasses import dataclass

@dataclass
class Config:
    BOT_TOKEN: str
    REPLICATE_TOKEN: str
    DATABASE_URL: str

def load_config() -> Config:
    return Config(
        BOT_TOKEN=os.getenv('BOT_TOKEN'),
        REPLICATE_TOKEN=os.getenv('REPLICATE_TOKEN'),
        DATABASE_URL=os.getenv('DATABASE_URL')
    )