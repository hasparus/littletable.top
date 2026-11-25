const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, STAGE: stage } = process.env;

if (!/^[a-f0-9]{32}$/u.test(account ?? "") || !token || !/^pr-[1-9]\d*$/u.test(stage ?? "")) {
  throw new Error("Missing or invalid Cloudflare preview settings.");
}

async function request(path, options = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (response.status === 404 && options.allowMissing) return null;
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(`Cloudflare request failed for ${path} (HTTP ${response.status}).`);
  }
  return data.result;
}

async function query(path, sql, params = []) {
  const [result] = await request(`${path}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
  if (!result?.success || !Array.isArray(result.results)) {
    throw new Error("Could not verify the preview database.");
  }
  return result.results;
}

async function matchesPartition(legacy) {
  const databases = await request("/d1/database?name=littletable-preview-accounts");
  const shared = databases.find(({ name }) => name === "littletable-preview-accounts");
  if (shared === undefined) return false;
  const destination = `/d1/database/${shared.uuid}`;
  const boards =
    "SELECT id, owner_id, title, share_code, link_version, created_at, has_thumbnail FROM boards";
  const visits = "SELECT v.account_id, v.board_id, v.share_code, v.visited_at FROM visits v";
  for (const [sourceSql, destinationSql, order] of [
    [boards, `${boards} WHERE deployment = ?`, "id"],
    [
      visits,
      `${visits} JOIN boards b ON v.board_id = b.id WHERE b.deployment = ?`,
      "v.account_id, v.board_id",
    ],
  ]) {
    for (let offset = 0; ; offset += 100) {
      const suffix = ` ORDER BY ${order} LIMIT 100 OFFSET ?`;
      const [original, copied] = await Promise.all([
        query(legacy, sourceSql + suffix, [offset]),
        query(destination, destinationSql + suffix, [stage, offset]),
      ]);
      if (JSON.stringify(original) !== JSON.stringify(copied)) return false;
      if (original.length < 100) break;
    }
  }
  return true;
}

const worker = await request(`/workers/scripts/littletable-${stage}/settings`, {
  allowMissing: true,
});
if (worker !== null) {
  const binding = worker.bindings.find(({ name, type }) => name === "DB" && type === "d1");
  if (!binding?.id || !/^[a-f0-9-]{36}$/u.test(binding.id)) {
    throw new Error("The existing preview has no identifiable D1 binding.");
  }
  const path = `/d1/database/${binding.id}`;
  const database = await request(path);
  if (database.name !== "littletable-preview-accounts") {
    const legacyName = new RegExp(`^LittleTablePreview-TabletopAccounts-${stage}-[a-z0-9]+$`, "u");
    if (!legacyName.test(database.name)) {
      throw new Error("The preview is bound to an unexpected D1 database.");
    }
    const [count] = await query(path, "SELECT count(*) AS boards FROM boards");
    if (count.boards !== 0 && !(await matchesPartition(path))) {
      throw new Error(
        `Preview ${stage} has saved boards. Migrate them before switching its D1 binding.`,
      );
    }
    process.stdout.write(database.name);
  }
}
