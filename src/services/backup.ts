import { Pool } from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ENV } from '../config/environment';
import { db } from './database';

const execAsync = promisify(exec);

export class BackupService {
    private backupPath: string;
    
    constructor(private pool: Pool) {
        this.backupPath = path.join(__dirname, '../../backups');
    }

    private async ensureBackupDir(): Promise<void> {
        await fs.mkdir(this.backupPath, { recursive: true });
    }

    async createBackup(): Promise<void> {
        try {
            await this.ensureBackupDir();

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `backup_${timestamp}.sql`;
            const filePath = path.join(this.backupPath, filename);

            // Создаем дамп базы данных
            const { PGDATABASE, PGHOST, PGPORT, PGUSER, PGPASSWORD } = process.env;
            const command = `PGPASSWORD=${PGPASSWORD} pg_dump -h ${PGHOST} -p ${PGPORT} -U ${PGUSER} -d ${PGDATABASE} -F p -f ${filePath}`;
            
            await execAsync(command);

            // Получаем размер файла
            const stats = await fs.stat(filePath);

            // Записываем информацию о бэкапе
            await db.recordBackup({
                filename,
                sizeBytes: stats.size,
                storagePath: filePath,
                status: 'completed'
            });

            // Удаляем старые бэкапы (оставляем последние 5)
            const files = await fs.readdir(this.backupPath);
            const backupFiles = files.filter(f => f.startsWith('backup_')).sort();
            
            while (backupFiles.length > 5) {
                const oldFile = backupFiles.shift();
                if (oldFile) {
                    await fs.unlink(path.join(this.backupPath, oldFile));
                }
            }
        } catch (error) {
            console.error('Ошибка при создании бэкапа:', error);
            
            await db.recordBackup({
                filename: `failed_backup_${new Date().toISOString()}`,
                sizeBytes: 0,
                storagePath: '',
                status: 'failed',
                errorMessage: error instanceof Error ? error.message : 'Unknown error'
            });

            throw error;
        }
    }

    async restoreFromBackup(filename: string): Promise<void> {
        const filePath = path.join(this.backupPath, filename);
        
        try {
            // Проверяем существование файла
            await fs.access(filePath);

            const { PGDATABASE, PGHOST, PGPORT, PGUSER, PGPASSWORD } = process.env;
            const command = `PGPASSWORD=${PGPASSWORD} psql -h ${PGHOST} -p ${PGPORT} -U ${PGUSER} -d ${PGDATABASE} -f ${filePath}`;
            
            await execAsync(command);
        } catch (error) {
            console.error('Ошибка при восстановлении из бэкапа:', error);
            throw error;
        }
    }

    async scheduleRegularBackups(): Promise<void> {
        // Создаем бэкап каждый день в 3 часа ночи
        const schedule = require('node-schedule');
        schedule.scheduleJob('0 3 * * *', async () => {
            try {
                await this.createBackup();
                console.log('Ежедневный бэкап создан успешно');
            } catch (error) {
                console.error('Ошибка при создании ежедневного бэкапа:', error);
            }
        });
    }
}

export const backupService = new BackupService(db.pool);