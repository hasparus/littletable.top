import { importPKCS8, SignJWT } from "jose";
import { readFileSync } from "node:fs";
const key = await importPKCS8(readFileSync(new URL("../dev/dev-signing-key.pem", import.meta.url), "utf8"), "RS256");
const at = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ boards: [{ access: "write", board: "zz", grant: 0 }] }).setProtectedHeader({ alg: "RS256" }).setAudience("tabletop-mcp").setIssuer("dev-host").setSubject("u:1").setIssuedAt(at).setExpirationTime(at + 300).sign(key);
const r = await fetch("http://localhost:8791/mcp", { method: "POST", headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apply_ops", arguments: { boardId: "zz", ops: [{ op: "add", text: "hi", at: { x: 0, y: 0 } }] } } }) });
console.log(r.status, (await r.text()).slice(0, 600));
