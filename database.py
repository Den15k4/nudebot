import sqlite3
from datetime import datetime, timedelta
import logging
import os

class Database:
    def __init__(self, database_url):
        self.database_url = database_url
        logging.info(f"Initializing database with URL: {database_url}")

    def init_db(self):
        """Инициализация базы данных с проверками"""
        try:
            logging.info("Starting database initialization...")
            conn = sqlite3.connect(self.database_url)
            c = conn.cursor()
            
            # Таблица пользователей
            c.execute('''
                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY,
                    username TEXT,
                    registered_at TEXT
                )
            ''')
            logging.info("Users table created/verified")
            
            # Таблица подписок
            c.execute('''
                CREATE TABLE IF NOT EXISTS subscriptions (
                    user_id INTEGER PRIMARY KEY,
                    images_left INTEGER DEFAULT 3,
                    subscription_end TEXT
                )
            ''')
            logging.info("Subscriptions table created/verified")
            
            # Проверяем создание таблиц
            c.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = c.fetchall()
            logging.info(f"Available tables: {tables}")
            
            conn.commit()
            conn.close()
            logging.info("Database initialization completed successfully")
            
        except Exception as e:
            logging.error(f"Error initializing database: {e}")
            raise

    def check_subscription(self, user_id: int) -> tuple:
        """Проверка подписки пользователя с созданием записи если её нет"""
        try:
            conn = sqlite3.connect(self.database_url)
            c = conn.cursor()
            
            # Проверяем существование подписки
            c.execute('SELECT images_left FROM subscriptions WHERE user_id = ?', (user_id,))
            result = c.fetchone()
            
            if not result:
                logging.info(f"Creating new subscription for user {user_id}")
                # Если подписки нет, создаем тестовую с 3 изображениями
                subscription_end = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d %H:%M:%S')
                c.execute(
                    'INSERT INTO subscriptions (user_id, images_left, subscription_end) VALUES (?, ?, ?)',
                    (user_id, 3, subscription_end)
                )
                conn.commit()
                images_left = 3
            else:
                images_left = result[0]
                
            conn.close()
            return True, images_left
            
        except Exception as e:
            logging.error(f"Error checking subscription: {e}")
            return False, 0

    def update_images_count(self, user_id: int):
        """Обновление количества доступных изображений"""
        try:
            conn = sqlite3.connect(self.database_url)
            c = conn.cursor()
            c.execute('UPDATE subscriptions SET images_left = images_left - 1 WHERE user_id = ?', (user_id,))
            conn.commit()
            conn.close()
            logging.info(f"Updated images count for user {user_id}")
        except Exception as e:
            logging.error(f"Error updating images count: {e}")
            raise