import sqlite3
from datetime import datetime, timedelta
import os

class Database:
    def __init__(self, database_url):
        self.database_url = database_url

    def init_db(self):
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
        
        # Таблица подписок (для тестирования даем всем по 3 изображения)
        c.execute('''
            CREATE TABLE IF NOT EXISTS subscriptions (
                user_id INTEGER PRIMARY KEY,
                images_left INTEGER DEFAULT 3,
                subscription_end TEXT
            )
        ''')
        
        conn.commit()
        conn.close()

    def check_subscription(self, user_id: int) -> tuple:
        conn = sqlite3.connect(self.database_url)
        c = conn.cursor()
        
        # Проверяем существование подписки
        c.execute('SELECT images_left FROM subscriptions WHERE user_id = ?', (user_id,))
        result = c.fetchone()
        
        if not result:
            # Если подписки нет, создаем тестовую с 3 изображениями
            subscription_end = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d %H:%M:%S')
            c.execute(
                'INSERT INTO subscriptions (user_id, images_left, subscription_end) VALUES (?, ?, ?)',
                (user_id, 3, subscription_end)
            )
            conn.commit()
            conn.close()
            return True, 3
        
        images_left = result[0]
        conn.close()
        return True, images_left

    def update_images_count(self, user_id: int):
        conn = sqlite3.connect(self.database_url)
        c = conn.cursor()
        c.execute('UPDATE subscriptions SET images_left = images_left - 1 WHERE user_id = ?', (user_id,))
        conn.commit()
        conn.close()
