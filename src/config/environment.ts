import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const ENV = {
    BOT_TOKEN: process.env.BOT_TOKEN || '7543266158:AAETR2eLuk2joRxh6w2IvPePUw2LZa8_56U',
    CLOTHOFF_API_KEY: process.env.CLOTHOFF_API_KEY || '4293b3bc213bba6a74011fba8d4ad9bd460599d9',
    WEBHOOK_URL: process.env.WEBHOOK_URL || 'https://nudebot-production.up.railway.app/webhook',
    PORT: parseInt(process.env.PORT || '8080', 10),
    DATABASE_URL: process.env.DATABASE_URL || '',
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()),
    SHOP_ID: process.env.SHOP_ID || '2660',
    RUKASSA_TOKEN: process.env.TOKEN || '9876a82910927a2c9a43f34cb5ad2de7'
} as const;

export const PATHS = {
    ASSETS: {
        WELCOME: path.join(__dirname, '../../assets/welcome.jpg'),
        BALANCE: path.join(__dirname, '../../assets/balance.jpg'),
        PAYMENT: path.join(__dirname, '../../assets/payment.jpg'),
        PAYMENT_PROCESS: path.join(__dirname, '../../assets/payment_process.jpg'),
        REFERRAL: path.join(__dirname, '../../assets/referral.jpg')
    }
} as const;