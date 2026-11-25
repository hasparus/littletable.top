import type { AssistantGrants } from "./assistant-grants";

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function assistantsPage(grants: AssistantGrants, account: string, csrf: string) {
  const clients = await grants.clients(account);
  const groups = await Promise.all(
    clients.map(async (client, index) => {
      const boards = await grants.boards(account, client);
      const rows = boards
        .map(
          ({ access, board, title }) => `<form method="post" action="/assistants">
      <input type="hidden" name="csrf" value="${escape(csrf)}" />
      <input type="hidden" name="client" value="${escape(client)}" />
      <input type="hidden" name="board" value="${escape(board)}" />
      <label>${escape(title)}<select name="access">
        <option value="off"${access === "off" ? " selected" : ""}>Off</option>
        <option value="read"${access === "read" ? " selected" : ""}>Read</option>
        <option value="write"${access === "write" ? " selected" : ""}>Edit</option>
      </select></label><button>Save</button>
    </form>`,
        )
        .join("");
      return `<section><h2>Client ${index + 1}</h2><p class="client">${escape(client)}</p>${rows || "<p>No eligible boards.</p>"}</section>`;
    }),
  );
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Assistants · Little Table</title><style>
      :root { color-scheme: light dark; font: 1rem/1.55 system-ui, sans-serif; }
      body { max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
      section { margin-block: 1.5rem; padding: 1rem; border: 1px solid GrayText; border-radius: .75rem; }
      h1, h2 { margin-block: .5rem; } .client { overflow-wrap: anywhere; color: GrayText; }
      form, label { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
      form { padding-block: .5rem; } label { flex: 1; justify-content: space-between; }
      select, button { font: inherit; min-height: 2.75rem; padding-inline: .5rem; }
    </style><main><a href="/">Little Table</a><h1>Assistants</h1>
    <p>Choose the boards each client can read or edit. Access is off until you grant it.</p>
    ${groups.join("") || "<p>Connect a client to Little Table MCP and sign in to see it here.</p>"}
    </main></html>`,
    { headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" } },
  );
}
