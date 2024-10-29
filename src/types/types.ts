import { Context, NarrowedContext } from 'telegraf';
import { Update, Message } from 'telegraf/types';
import { CallbackQuery } from 'telegraf/types';

export interface SessionData {
    // Добавьте здесь данные сессии, если они нужны
}

export interface BotContext extends Context {
    session?: SessionData;
}

export type CommandContext = NarrowedContext<BotContext, Update.MessageUpdate<Message>>;
export type CallbackContext = NarrowedContext<BotContext, Update.CallbackQueryUpdate>;