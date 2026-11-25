import { describe, expect, it } from "vitest";

import { BOARD_NOT_FOUND, UNTRUSTED } from "../../src/mcp/server";
import { roomOf, token, worker } from "./support";

// The MCP Worker's endpoint in workerd, as an assistant's client speaks to
// it: the 2025 handshake and the 2026-07-28 revision's handshake-free
// requests, tools/list, and apply_ops on a board nobody has open, which
// lives in the board Worker.

const MCP = "https://mcp.test";

type Rpc = { method: string; params?: { name?: string } };

const routing = ({ method, params }: Rpc): Record<string, string> => ({
  "Mcp-Method": method,
  ...(params?.name === undefined ? {} : { "Mcp-Name": params.name }),
});

let ids = 0;
const rpc = (method: string, params: object = {}) => ({
  id: ++ids,
  jsonrpc: "2.0",
  method,
  params,
});

async function post(bearer: string | null, body: object, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${MCP}/mcp`, {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
        // NOTE: the 2026-07-28 revision repeats the method (and a tool's
        // name) in headers, so proxies can route without reading the body.
        ...(headers["MCP-Protocol-Version"] === MODERN ? routing(body as Rpc) : {}),
        ...headers,
      },
      method: "POST",
    }),
  );
}

async function result(response: Response) {
  const type = response.headers.get("Content-Type") ?? "";
  const text = await response.text();
  if (type.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    return data.at(-1);
  }
  return JSON.parse(text);
}

const MODERN = "2026-07-28";
const modernMeta = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/protocolVersion": MODERN,
};

describe("the MCP endpoint", () => {
  it("points a client without a token at the host's authorization server", async () => {
    const response = await post(null, rpc("tools/list"));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="boards:read boards:write"',
    );
    const metadata = await worker.fetch(`${MCP}/.well-known/oauth-protected-resource/mcp`);
    expect(await metadata.json()).toEqual({
      authorization_servers: ["http://localhost:8000"],
      bearer_methods_supported: ["header"],
      resource: "https://mcp.test/mcp",
      resource_name: "Tabletop boards",
      scopes_supported: ["boards:read", "boards:write"],
    });
    const pass = await token([], { audience: "board" });
    expect((await post(pass, rpc("tools/list"))).status).toBe(401);
  });

  it("answers the 2025 handshake and lists the tools with the op vocabulary", async () => {
    const bearer = await token([{ access: "write", board: "mcp-a", title: "Campaign map" }]);
    const init = await result(
      await post(
        bearer,
        rpc("initialize", {
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
          protocolVersion: "2025-11-25",
        }),
      ),
    );
    expect(init.result).toMatchObject({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "tabletop-boards" },
    });
    const list = await result(
      await post(bearer, rpc("tools/list"), { "MCP-Protocol-Version": "2025-11-25" }),
    );
    const tools = list.result.tools as {
      annotations: object;
      inputSchema: { properties: Record<string, unknown> };
      name: string;
    }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_boards",
      "get_board_info",
      "get_page_info",
      "get_cluster_info",
      "apply_ops",
      "search_shapes",
    ]);
    const ops = JSON.stringify(tools[4]!.inputSchema.properties.ops);
    for (const name of [
      "add",
      "place",
      "label",
      "connect",
      "rename",
      "restyle",
      "remove",
      "untangle",
      "resize",
      "path",
      "duplicate",
    ]) {
      expect(ops).toContain(`"const":"${name}"`);
    }
  });

  it("serves the 2026-07-28 revision without a handshake, and applies ops to a board nobody has open", async () => {
    const bearer = await token([{ access: "write", board: "mcp-b", title: "Heist" }]);
    const headers = { "MCP-Protocol-Version": MODERN };
    const list = await result(
      await post(bearer, rpc("tools/list", { _meta: modernMeta }), headers),
    );

    expect(list.result.tools).toHaveLength(6);
    const applied = await result(
      await post(
        bearer,
        rpc("tools/call", {
          _meta: modernMeta,
          arguments: {
            boardId: "mcp-b",
            ops: [
              { at: { x: 0, y: 0 }, id: "vault", op: "add", text: "Vault" },
              { id: "guard", op: "add", relation: "below", target: "vault", text: "Guard post" },
              { from: "guard", op: "connect", text: "patrol", to: "vault" },
            ],
          },
          name: "apply_ops",
        }),
        headers,
      ),
    );
    expect(applied.result.isError).toBeUndefined();
    expect(applied.result.content[0]).toEqual({ text: UNTRUSTED, type: "text" });
    const body = JSON.parse(applied.result.content[1].text);
    expect(body).toMatchObject({ applied: 3, errors: [], pageName: "Page 1" });
    const snapshot = await roomOf("mcp-b").readDocument(
      { access: "read", board: "mcp-b", grant: 0, role: "owner", title: null },
      { scope: "document" },
    );
    const records = snapshot === "revoked" ? [] : snapshot.records;
    expect(records.map((record) => record.id)).toEqual(
      expect.arrayContaining(["shape:vault", "shape:guard"]),
    );
  });

  it("gives one answer for a board that is not granted and one that does not exist", async () => {
    const bearer = await token([{ access: "read", board: "mcp-c" }]);
    const ask = async (boardId: string, name = "get_board_info", extra: object = {}) =>
      (
        await result(
          await post(
            bearer,
            rpc("tools/call", { _meta: modernMeta, arguments: { boardId, ...extra }, name }),
            { "MCP-Protocol-Version": MODERN },
          ),
        )
      ).result;
    expect(await ask("someone-elses")).toMatchObject({
      content: [{ text: BOARD_NOT_FOUND, type: "text" }],
      isError: true,
    });
    expect((await ask("mcp-c")).isError).toBeUndefined();
    expect(await ask("mcp-c", "apply_ops", { ops: [{ op: "add", text: "x" }] })).toMatchObject({
      content: [{ text: expect.stringMatching(/may read this board but not change it/u) }],
      isError: true,
    });
    const invalid = await ask("mcp-c", "apply_ops", { ops: [] });
    expect(invalid).toMatchObject({
      content: [{ text: expect.stringMatching(/ops/u) }],
      isError: true,
    });
  });

  it("reads a board back: its pages, a page's clusters, a cluster's shapes, and shapes by text", async () => {
    const bearer = await token([{ access: "write", board: "mcp-d", title: "Read me" }]);
    const headers = { "MCP-Protocol-Version": MODERN };
    const call = async (name: string, args: object) => {
      const answer = await result(
        await post(
          bearer,
          rpc("tools/call", { _meta: modernMeta, arguments: args, name }),
          headers,
        ),
      );
      expect(answer.result.isError, JSON.stringify(answer.result)).toBeUndefined();
      expect(answer.result.content[0]).toEqual({ text: UNTRUSTED, type: "text" });
      return JSON.parse(answer.result.content[1].text);
    };
    await call("apply_ops", {
      boardId: "mcp-d",
      ops: [
        { at: { x: 0, y: 0 }, id: "inn", op: "add", text: "Inn of the goblin" },
        { id: "stable", op: "add", relation: "right_of", target: "inn", text: "Stable" },
        { from: "inn", id: "path", op: "connect", to: "stable" },
        { at: { x: 5000, y: 5000 }, id: "tower", op: "add", text: "Wizard tower" },
      ],
    });
    expect(await call("get_board_info", { boardId: "mcp-d" })).toEqual({
      name: "Read me",
      pageCount: 1,
      pages: [{ hasContent: true, id: "page:page", index: 0, name: "Page 1" }],
    });
    const page = await call("get_page_info", { boardId: "mcp-d", page: "page:page" });
    expect(page).toMatchObject({ clusterCount: 2, name: "Page 1" });
    expect(
      page.clusters.map((cluster: { numberOfShapes: number }) => cluster.numberOfShapes),
    ).toEqual([3, 1]);
    const info = await call("get_cluster_info", {
      boardId: "mcp-d",
      clusterIds: [page.clusters[0].id],
    });
    const shapes = info.clusters[0].shapes as { id: string; props: Record<string, unknown> }[];
    expect(shapes.map((shape) => shape.id).sort()).toEqual([
      "shape:inn",
      "shape:path",
      "shape:stable",
    ]);
    expect(shapes.find((shape) => shape.id === "shape:inn")!.props.text).toBe("Inn of the goblin");
    expect(shapes.find((shape) => shape.id === "shape:path")!.props).toMatchObject({
      bindingFromId: "shape:inn",
      bindingToId: "shape:stable",
    });
    expect(await call("search_shapes", { boardId: "mcp-d", query: "wizard" })).toEqual({
      matchCount: 1,
      matches: [
        {
          boardId: "mcp-d",
          bounds: { h: 32, w: 170, x: 5000, y: 5000 },
          confidence: 1,
          excerpt: "Wizard tower",
          pageId: "page:page",
          shapeId: "tower",
          source: "native",
        },
      ],
    });
  });
});
