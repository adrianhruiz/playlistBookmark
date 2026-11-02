import type { FetchFn } from "./env";

export type InlineButton = { text: string; url: string } | { text: string; callback_data: string };

export interface TelegramUpdate {
  message?: { chat: { id: number; type?: string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

export class TelegramClient {
  private readonly fetch: FetchFn;

  constructor(
    private readonly token: string,
    fetchFn?: FetchFn,
  ) {
    this.fetch = fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Sends a message; `buttons` is one inline-keyboard row per entry. */
  async sendMessage(chatId: number, text: string, buttons: InlineButton[][] = []): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  private async call(method: string, payload: unknown): Promise<void> {
    const response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
    }
  }
}
