import hmac
import hashlib
from aiohttp import web
from typing import Optional
import logging

logger = logging.getLogger(__name__)

def generate_webhook_signature(payload: bytes, secret: str) -> str:
    """Генерация подписи для webhook"""
    return hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()

async def validate_webhook_request(request: web.Request, secret: str) -> bool:
    """Валидация входящих webhook-запросов"""
    try:
        if 'X-Clothoff-Signature' not in request.headers:
            logger.warning("Missing webhook signature")
            return False
            
        signature = request.headers['X-Clothoff-Signature']
        body = await request.read()
        
        expected_signature = generate_webhook_signature(body, secret)
        
        return hmac.compare_digest(signature, expected_signature)
        
    except Exception as e:
        logger.error(f"Error validating webhook: {e}")
        return False

class WebhookResponse:
    """Класс для формирования ответов на webhook-запросы"""
    
    @staticmethod
    def success() -> web.Response:
        return web.Response(status=200)
    
    @staticmethod
    def error(message: str, status: int = 400) -> web.Response:
        return web.Response(
            status=status,
            text=message
        )
    
    @staticmethod
    def unauthorized() -> web.Response:
        return web.Response(status=401)
    
    @staticmethod
    def not_found() -> web.Response:
        return web.Response(status=404)
    
    @staticmethod
    def server_error() -> web.Response:
        return web.Response(status=500)

async def setup_webhook_routes(app: web.Application, handler) -> None:
    """Настройка маршрутов для webhooks"""
    app.router.add_post('/webhook', handler)
    
    async def health_check(request: web.Request) -> web.Response:
        return WebhookResponse.success()
    
    app.router.add_get('/health', health_check)