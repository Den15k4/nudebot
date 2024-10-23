import logging
from datetime import datetime, timedelta
from sqlalchemy import create_engine, Column, BigInteger, Integer, String, DateTime, inspect
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.sql import func

# Настройка логирования
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

Base = declarative_base()

class User(Base):
    __tablename__ = 'users'
    
    user_id = Column(BigInteger, primary_key=True)
    username = Column(String)
    registered_at = Column(DateTime, default=func.now())

class Subscription(Base):
    __tablename__ = 'subscriptions'
    
    user_id = Column(BigInteger, primary_key=True)
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
        
        session_factory = sessionmaker(bind=self.engine)
        self.Session = scoped_session(session_factory)

    def init_db(self):
        """Инициализация базы данных"""
        try:
            logger.info("Starting database initialization...")
            
            # Удаляем все таблицы и создаем заново
            Base.metadata.drop_all(self.engine)
            logger.info("Dropped all existing tables")
            
            # Создаем все таблицы
            Base.metadata.create_all(self.engine)
            logger.info("Created all tables")
            
            # Проверяем созданные таблицы
            inspector = inspect(self.engine)
            tables = inspector.get_table_names()
            logger.info(f"Available tables: {tables}")
            
            # Проверяем структуру таблиц
            for table_name in tables:
                columns = inspector.get_columns(table_name)
                column_info = [f"{col['name']} ({col['type']})" for col in columns]
                logger.info(f"Table {table_name} columns: {', '.join(column_info)}")
            
            return True
        
        except Exception as e:
            logger.error(f"Error initializing database: {e}")
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
                    images_left = 3
                else:
                    images_left = subscription.images_left
                
                logger.info(f"User {user_id} has {images_left} images left")
                return True, images_left
            
            except Exception as e:
                logger.error(f"Database error: {e}")
                session.rollback()
                raise
            
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
                    user = User(user_id=user_id, username=username)
                    session.add(user)
                    session.commit()
                    logger.info(f"Registered new user: {username} ({user_id})")
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error registering user: {e}")
            raise