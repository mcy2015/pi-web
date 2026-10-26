// Client-safe Telegram integration types: what the Settings panel and the
// API exchange. The bot token itself never crosses this boundary whole: the
// API answers with tokenSet plus a last-4 hint only.

export interface TelegramAllowedChat {
  id: number;
  /** The chat's display name, recorded when it was allowlisted. */
  title: string | null;
  /** Where this chat's sessions run; null falls back to the channel default. */
  cwd: string | null;
}

export interface TelegramConfigView {
  tokenSet: boolean;
  /** Last 4 characters of the stored token, e.g. "OVhg"; null without one. */
  tokenHint: string | null;
  enabled: boolean;
  defaultCwd: string | null;
  allowedChats: TelegramAllowedChat[];
}

export interface TelegramStatus {
  config: TelegramConfigView;
  /** The polling loop is alive (token + enabled + no fatal error). */
  running: boolean;
  /** Bot username from getMe, once the loop has reached Telegram. */
  botUsername: string | null;
  lastError: string | null;
  lastConnectedAt: number | null;
  /** The most recent message from a chat that is not allowlisted. */
  lastUnknownChat: { id: number; title: string | null; at: number } | null;
}
