import logging
from datetime import datetime, timedelta
from sqlalchemy import create_engine, Column, BigInteger, Integer, String, DateTime, MetaData, inspect
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.sql import func

# Настройка логирования
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

metadata = MetaData()
Base = declarative_base(metadata=metadata)

class User(Base):
    __tablename__ = 'users'
    
    user_id = Column(BigInteger, primary_key=True, autoincrement=False)
    username = Column(String(100))
    registered_at = Column(DateTime, server_default=func.now())

class Subscription(Base):
    __tablename__ = 'subscriptions'
    
    user_id = Column(BigInteger, primary_key=True, autoincrement=False)
    images_left = Column(Integer, default=3)
    subscription_end = Column(DateTime)

class Database:
    def __init__(self, database_url):
        self.database_url = database_url
        logger.info(f"Initializing database with URL: {database_url}")
        
        self.engine = create_engine(
            self.database_url,
            pool_size=5,
            max_overflow=10,
            pool_timeout=30,
            pool_pre_ping=True,
            echo=True
        )
        
        # Создаем таблицы, только если они не существуют
        self._create_tables_if_not_exist()
        
        session_factory = sessionmaker(bind=self.engine)
        self.Session = scoped_session(session_factory)
        
        logger.info("Database initialization completed")

    def _create_tables_if_not_exist(self):
        """Создание таблиц, если они не существуют"""
        try:
            inspector = inspect(self.engine)
            existing_tables = inspector.get_table_names()
            
            logger.info(f"Existing tables: {existing_tables}")
            
            # Создаем только отсутствующие таблицы
            tables_to_create = []
            for table in Base.metadata.tables.values():
                if table.name not in existing_tables:
                    tables_to_create.append(table)
                    logger.info(f"Table {table.name} will be created")
            
            if tables_to_create:
                # Создаем только новые таблицы
                Base.metadata.create_all(self.engine, tables=tables_to_create)
                logger.info("New tables created successfully")
            else:
                logger.info("All required tables already exist")
            
        except Exception as e:
            logger.error(f"Error checking/creating tables: {e}")
            raise

    def check_subscription(self, user_id: int) -> tuple:
        """Проверка подписки пользователя"""
        try:
            session = self.Session()
            try:
                logger.info(f"Checking subscription for user {user_id}")
                subscription = session.query(Subscription).filter_by(user_id=user_id).first()
                
                if not subscription:
                    logger.info(f"Creating new subscription for user {user_id}")
                    subscription = Subscription(
                        user_id=user_id,
                        images_left=3,
                        subscription_end=datetime.now() + timedelta(days=30)
                    )
                    session.add(subscription)
                    session.commit()
                    logger.info(f"Created subscription for user {user_id}")
                    images_left = 3
                else:
                    images_left = subscription.images_left
                    logger.info(f"Found existing subscription: {images_left} images left")
                
                return True, images_left
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error checking subscription: {e}")
            return False, 0

    def update_images_count(self, user_id: int):
        """Обновление количества доступных изображений"""
        try:
            session = self.Session()
            try:
                subscription = session.query(Subscription).filter_by(user_id=user_id).first()
                
                if subscription and subscription.images_left > 0:
                    subscription.images_left -= 1
                    session.commit()
                    logger.info(f"Updated images count for user {user_id}, now has {subscription.images_left} images")
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error updating images count: {e}")
            raise

    def register_user(self, user_id: int, username: str):
        """Регистрация нового пользователя"""
        try:
            session = self.Session()
            try:
                user = session.query(User).filter_by(user_id=user_id).first()
                
                if not user:
                    user = User(
                        user_id=user_id,
                        username=username
                    )
                    session.add(user)
                    session.commit()
                    logger.info(f"Registered new user: {username} ({user_id})")
                else:
                    # Обновляем username если изменился
                    if user.username != username:
                        user.username = username
                        session.commit()
                        logger.info(f"Updated username for user {user_id}: {username}")
                    else:
                        logger.info(f"User already exists: {username} ({user_id})")
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error registering user: {e}")
            raise

    def get_user_stats(self, user_id: int) -> dict:
        """Получение статистики пользователя"""
        try:
            session = self.Session()
            try:
                stats = {
                    'subscription': None,
                    'registered_at': None,
                    'images_used': 0
                }
                
                user = session.query(User).filter_by(user_id=user_id).first()
                if user:
                    stats['registered_at'] = user.registered_at
                
                subscription = session.query(Subscription).filter_by(user_id=user_id).first()
                if subscription:
                    stats['subscription'] = {
                        'images_left': subscription.images_left,
                        'subscription_end': subscription.subscription_end
                    }
                    stats['images_used'] = 3 - subscription.images_left
                
                return stats
            finally:
                session.close()
        except Exception as e:
            logger.error(f"Error getting user stats: {e}")
            return None