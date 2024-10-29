import { Context as TelegrafContext } from 'telegraf/typings/context';
import { Message, Update } from 'telegraf/typings/core/types/typegram';

// Extended context type
export interface BotContext extends TelegrafContext {
    match?: RegExpExecArray;
}

// Specific message context type
export interface MessageContext extends BotContext {
    message: Update.New & Update.NonChannel & Message.TextMessage;
    update: Update.MessageUpdate<Message>;
}

// Specific callback query context type
export interface CallbackContext extends BotContext {
    callbackQuery: Update.CallbackQuery;
    update: Update.CallbackQueryUpdate;
}