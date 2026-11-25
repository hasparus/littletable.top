import { CHAT_HISTORY_LENGTH, type ChatMessage } from "./chat";

type ChatRow = Omit<ChatMessage, "diceTotal"> & { dice_total: number | null };

function chatMessage({ dice_total, ...message }: ChatRow) {
  const entry: ChatMessage = message;
  if (dice_total !== null) entry.diceTotal = dice_total;
  return entry;
}

function trimHistory(sql: SqlStorage) {
  sql.exec(
    "DELETE FROM chat WHERE id <= (SELECT id FROM chat ORDER BY id DESC LIMIT 1 OFFSET ?)",
    CHAT_HISTORY_LENGTH,
  );
}

export function openChat(sql: SqlStorage) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL)",
  );
  if (
    sql.exec("SELECT name FROM pragma_table_info('chat') WHERE name = 'dice_total'").toArray()
      .length > 0
  )
    return;

  sql.exec("ALTER TABLE chat ADD COLUMN dice_total REAL");
  sql.exec(
    "INSERT INTO chat (at, sub, name, text, dice_total) SELECT at, sub, name, expression, json_extract(outcome, '$.total') FROM rolls WHERE chat = 1 AND expression IS NOT NULL AND outcome IS NOT NULL ORDER BY id",
  );
  trimHistory(sql);
}

export function recentChat(sql: SqlStorage) {
  return sql
    .exec<ChatRow>("SELECT id, at, sub, name, text, dice_total FROM chat ORDER BY id")
    .toArray()
    .map(chatMessage);
}

export function appendChat(sql: SqlStorage, entry: Omit<ChatMessage, "id">) {
  const row = sql
    .exec<ChatRow>(
      "INSERT INTO chat (at, sub, name, text, dice_total) VALUES (?, ?, ?, ?, ?) RETURNING id, at, sub, name, text, dice_total",
      entry.at,
      entry.sub,
      entry.name,
      entry.text,
      entry.diceTotal ?? null,
    )
    .one();
  trimHistory(sql);
  return chatMessage(row);
}
