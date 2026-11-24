export const CHAT_HISTORY_LENGTH = 100;
export const MAX_CHAT_LENGTH = 500;
export const MAX_CHAT_MESSAGES_PER_MINUTE = 20;

export type ChatMessage = {
  at: number;
  id: number;
  name: string;
  sub: string;
  text: string;
};
