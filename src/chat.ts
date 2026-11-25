export const CHAT_HISTORY_LENGTH = 100;
export const MAX_CHAT_LENGTH = 500;
export const MAX_CHAT_MESSAGES_PER_MINUTE = 20;

export function rollCommand(message: string) {
  const command = /^\/(?:roll|r)(?:\s+|$)/iu.exec(message);
  return command === null ? null : message.slice(command[0].length).trim();
}

export type ChatMessage = {
  at: number;
  diceTotal?: number;
  id: number;
  name: string;
  sub: string;
  text: string;
};
