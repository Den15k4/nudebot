from typing import Dict, Any, Optional, List
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

class StatisticsManager:
    """Управление статистикой генераций"""
    
    def __init__(self, db):
        self.db = db
    
    async def update_statistics(self, user_id: int, generation_data: dict) -> None:
        """Обновление статистики генераций"""
        try:
            self.db.update_statistics(user_id, generation_data)
        except Exception as e:
            logger.error(f"Error updating statistics: {e}")
    
   async def get_user_statistics(self, user_id: int) -> Dict[str, Any]:
        """Получение статистики пользователя"""
        try:
            stats = self.db.get_user_statistics(user_id)
            if not stats:
                return {
                    'total_generations': 0,
                    'successful_generations': 0,
                    'style_statistics': {},
                    'quality_distribution': {},
                    'average_generation_time': 0
                }
            
            return {
                'total_generations': stats.total_generations,
                'successful_generations': stats.successful_generations,
                'success_rate': (stats.successful_generations / stats.total_generations * 100 
                               if stats.total_generations > 0 else 0),
                'style_statistics': stats.style_statistics or {},
                'quality_distribution': self._calculate_quality_distribution(stats),
                'average_generation_time': self._calculate_average_time(stats)
            }
        except Exception as e:
            logger.error(f"Error getting user statistics: {e}")
            return {}
    
    async def get_global_statistics(self) -> Dict[str, Any]:
        """Получение глобальной статистики"""
        try:
            return {
                'total_users': self.db.get_total_users_count(),
                'total_generations': self.db.get_total_generations_count(),
                'popular_styles': self._get_popular_styles(),
                'average_success_rate': self._calculate_global_success_rate()
            }
        except Exception as e:
            logger.error(f"Error getting global statistics: {e}")
            return {}
    
    async def get_user_activity(self, user_id: int, days: int = 7) -> List[Dict[str, Any]]:
        """Получение статистики активности пользователя по дням"""
        try:
            start_date = datetime.now() - timedelta(days=days)
            activity = self.db.get_user_activity(user_id, start_date)
            
            # Формируем данные по дням
            daily_stats = []
            current_date = start_date
            
            while current_date <= datetime.now():
                date_str = current_date.strftime('%Y-%m-%d')
                daily_data = activity.get(date_str, {
                    'generations': 0,
                    'successful': 0,
                    'styles': {}
                })
                
                daily_stats.append({
                    'date': date_str,
                    'generations': daily_data['generations'],
                    'successful': daily_data['successful'],
                    'styles': daily_data['styles']
                })
                
                current_date += timedelta(days=1)
            
            return daily_stats
            
        except Exception as e:
            logger.error(f"Error getting user activity: {e}")
            return []
    
    def _calculate_quality_distribution(self, stats) -> Dict[str, float]:
        """Расчет распределения использования разных пресетов качества"""
        if not hasattr(stats, 'quality_stats') or not stats.quality_stats:
            return {}
            
        total = sum(stats.quality_stats.values())
        if total == 0:
            return {}
            
        return {
            preset: (count / total * 100)
            for preset, count in stats.quality_stats.items()
        }
    
    def _calculate_average_time(self, stats) -> float:
        """Расчет среднего времени генерации"""
        if not hasattr(stats, 'generation_times') or not stats.generation_times:
            return 0
            
        times = stats.generation_times
        return sum(times) / len(times) if times else 0
    
    def _get_popular_styles(self) -> Dict[str, int]:
        """Получение популярных стилей"""
        try:
            return self.db.get_style_popularity()
        except Exception as e:
            logger.error(f"Error getting popular styles: {e}")
            return {}
    
    def _calculate_global_success_rate(self) -> float:
        """Расчет общего процента успешных генераций"""
        try:
            total = self.db.get_total_generations_count()
            successful = self.db.get_successful_generations_count()
            return (successful / total * 100) if total > 0 else 0
        except Exception as e:
            logger.error(f"Error calculating global success rate: {e}")
            return 0