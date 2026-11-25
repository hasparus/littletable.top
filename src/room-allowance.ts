const MINUTE_MS = 60_000;

type Operation = "upload" | "text-claim" | "text-write";

export function openRoomAllowances(sql: SqlStorage) {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS room_allowances (operation TEXT NOT NULL, sub TEXT NOT NULL, stamps TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (operation, sub))",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS room_allowances_updated ON room_allowances (updated)");
}

export function spendRoomAllowance(
  sql: SqlStorage,
  operation: Operation,
  sub: string,
  at: number,
  perMinute: number,
) {
  const cutoff = at - MINUTE_MS;
  const [row] = sql
    .exec<{ stamps: string }>(
      "SELECT stamps FROM room_allowances WHERE operation = ? AND sub = ? AND updated > ?",
      operation,
      sub,
      cutoff,
    )
    .toArray();
  const recent: number[] = row === undefined ? [] : JSON.parse(row.stamps);
  const inWindow = recent.filter((stamp) => stamp > cutoff);
  if (inWindow.length >= perMinute) return false;
  inWindow.push(at);
  sql.exec("DELETE FROM room_allowances WHERE updated <= ?", cutoff);
  sql.exec(
    "INSERT INTO room_allowances (operation, sub, stamps, updated) VALUES (?, ?, ?, ?) ON CONFLICT(operation, sub) DO UPDATE SET stamps = excluded.stamps, updated = excluded.updated",
    operation,
    sub,
    JSON.stringify(inWindow),
    at,
  );
  return true;
}
