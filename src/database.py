import logging
from datetime import datetime
from typing import Optional, Dict, Any, List
from sqlalchemy import create_engine, Column, BigInteger, Integer, String, DateTime, JSON, MetaData
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.sql import func

logger = logging.getLogger(__name__)

metadata = MetaData()
Base = declarative_base(metadata=metadata)

class User(Base):
    __tablename__ = 'users'
    
    user_id = Column(BigInteger, primary_key=True)
    username = Column(String(100))
    registered_at = Column(DateTime, server_default=func.now())
    last_activity = Column(DateTime, server_default=func.now(), onupdate=func.now())
    settings = Column(JSON, default={})

class Subscription(Base):
    __tablename__ = 'subscriptions'
    
    user_id = Column(BigInteger, primary_key=True)
    images_left = Column(Integer, default=3)
    subscription_end = Column(DateTime)

class Generation(Base):
    __tablename__ = 'generations'
    
    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger)
    style = Column(String(100))
    params = Column(JSON)
    status = Column(String(20))
    created_at = Column(DateTime, server_default=func.now())
    completed_at = Column(DateTime)
    image_data = Column(String)

class Statistics(Base):
    __tablename__ = 'statistics'
    
    user_id = Column(BigInteger, primary_key=True)
    total_generations = Column(Integer, default=0)
    successful_generations = Column(Integer, default=0)
    style_statistics = Column(JSON, default={})

class Database:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self.engine = create_engine(
            self.database_url,
            pool_size=5,
            max_overflow=10,
            pool_timeout=30,
            pool_recycle=1800
        )
        self.Session = scoped_session(sessionmaker(bind=self.engine))
        
    def get_user(self, user_id: int) -> Optional[User]:
        """Получение пользователя"""
        session = self.Session()
        try:
            return session.query(User).filter_by(user_id=user_id).first()
        finally:
            session.close()

    def register_user(self, user_id: int, username: str) -> User:
        """Регистрация нового пользователя"""
        session = self.Session()
        try:
            user = session.query(User).filter_by(user_id=user_id).first()
            if not user:
                user = User(
                    user_id=user_id,
                    username=username,
                    settings={
                        "notifications_enabled": True,
                        "quality_preset": "balanced",
                        "autosave_enabled": False
                    }
                )
                session.add(user)
                session.commit()
            return user
        finally:
            session.close()

    def check_subscription(self, user_id: int) -> tuple[bool, int]:
        """Проверка подписки пользователя"""
        session = self.Session()
        try:
            subscription = session.query(Subscription).filter_by(user_id=user_id).first()
            
            if not subscription:
                subscription = Subscription(
                    user_id=user_id,
                    images_left=3,
                    subscription_end=datetime.now() + timedelta(days=30)
                )
                session.add(subscription)
                session.commit()
                return True, 3
                
            return True, subscription.images_left
        finally:
            session.close()

    def update_images_count(self, user_id: int) -> bool:
        """Обновление количества доступных изображений"""
        session = self.Session()
        try:
            subscription = session.query(Subscription).filter_by(user_id=user_id).first()
            if subscription and subscription.images_left > 0:
                subscription.images_left -= 1
                session.commit()
                return True
            return False
        finally:
            session.close()

    def save_generation(self, user_id: int, data: Dict[str, Any]) -> Generation:
        """Сохранение информации о генерации"""
        session = self.Session()
        try:
            generation = Generation(
                user_id=user_id,
                style=data['style'],
                params=data['params'],
                status=data['status'],
                image_data=data.get('image_data')
            )
            session.add(generation)
            session.commit()
            return generation
        finally:
            session.close()

    def get_user_generations(self, user_id: int, limit: int = 5) -> List[Generation]:
        """Получение истории генераций пользователя"""
        session = self.Session()
        try:
            return session.query(Generation).filter_by(
                user_id=user_id
            ).order_by(
                Generation.created_at.desc()
            ).limit(limit).all()
        finally:
            session.close()

    def update_user_settings(self, user_id: int, settings: Dict[str, Any]) -> bool:
        """Обновление настроек пользователя"""
        session = self.Session()
        try:
            user = session.query(User).filter_by(user_id=user_id).first()
            if user:
                user.settings.update(settings)
                session.commit()
                return True
            return False
        finally:
            session.close()

    def update_statistics(self, user_id: int, data: Dict[str, Any]) -> None:
        """Обновление статистики пользователя"""
        session = self.Session()
        try:
            stats = session.query(Statistics).filter_by(user_id=user_id).first()
            if not stats:
                stats = Statistics(user_id=user_id)
                session.add(stats)
            
            stats.total_generations += 1
            if data.get('status') == 'success':
                stats.successful_generations += 1
            
            style = data.get('style')
            if style:
                if not stats.style_statistics:
                    stats.style_statistics = {}
                stats.style_statistics[style] = stats.style_statistics.get(style, 0) + 1
            
            session.commit()
        finally:
            session.close()
