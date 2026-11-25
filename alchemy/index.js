// @ts-check
// The tabletop as one piece of a Cloudflare stack: its Worker, the board
// rooms' Durable Object, the boards' image bucket, and the client built for
// this deployment. A host
// writes `yield* Tabletop("Board", { mode: "hosted", ... })` inside its own
// Alchemy.Stack. Plain JavaScript on purpose: Alchemy's loader transpiles a
// stack's own TypeScript but leaves everything under node_modules to Node.

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageFile = (/** @type {string} */ path) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));

/** @type {{ compatibility_date: string }} */
const testedRuntime = JSON.parse(readFileSync(packageFile("wrangler.json"), "utf8"));

const pem = (/** @type {string} */ value) => value.replaceAll(String.raw`\n`, "\n");

// The committed dev pair's private half is public, so a Worker that trusts
// its public half, or signs with it, accepts passes anyone can sign.
const devPublicKey = createPublicKey(
  readFileSync(packageFile("dev/dev-signing-key.pem"), "utf8"),
).export({ format: "der", type: "spki" });

/** @param {import("node:crypto").KeyObject} key @param {string} name */
function refuseDevKey(key, name) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  if (publicKey.export({ format: "der", type: "spki" }).equals(devPublicKey)) {
    throw new Error(`tabletop: ${name} is the committed development key`);
  }
}

// NOTE: Cloudflare's published API types predate Workers Issues, so `issues`
// cannot sit in the Worker's props literal; Alchemy forwards the key anyway.
// Every deploy uploads this whole block, and one without `issues` turns
// Issues off.
const observability = {
  enabled: true,
  issues: { enabled: true },
  logs: { enabled: true, invocationLogs: false },
};

/** @param {string | Redacted.Redacted<string>} value */
const secret = (value) => (Redacted.isRedacted(value) ? value : Redacted.make(value));

/**
 * @param {import("./index.js").TabletopProps} props
 * @returns {{ client: import("../client/settings.ts").ClientSettings, env: Record<string, unknown> }}
 */
function configure(props) {
  const hosts = {
    ALIAS_HOSTS: (props.domain?.aliases ?? []).join(","),
    PRIMARY_HOST: props.domain?.primary ?? "",
  };
  const client = {
    brand: props.brand ?? {},
    description:
      props.description ?? "A shared whiteboard with dice, for games at the table and online.",
    hosted: null,
    language: props.language ?? "en",
    licenseKey: props.licenseKey ?? "",
    mode: props.mode,
    name: props.displayName ?? "Tabletop",
    shortName: props.shortName ?? props.displayName ?? "Tabletop",
  };
  if (props.mode === "hosted") {
    const hostOrigin = new URL(props.hostOrigin).origin;
    refuseDevKey(createPublicKey(pem(props.issuerPublicKey)), "issuerPublicKey");
    return {
      client: {
        ...client,
        hosted: {
          bootstrapUrl: `${hostOrigin}${props.bootstrapPath ?? "/b/{code}/bootstrap/"}`,
          exitUrl: props.exitUrl ?? `${hostOrigin}/`,
        },
      },
      env: {
        ...hosts,
        DELETION_AUDIENCE: props.deletionAudience ?? "board-deletion",
        HOME_URL: props.homeUrl ?? `${hostOrigin}/`,
        HOST_ORIGIN: hostOrigin,
        ISSUER: props.issuer,
        ISSUER_PUBLIC_KEY: props.issuerPublicKey,
        PASS_AUDIENCE: props.passAudience ?? "board",
        TABLETOP_MODE: "hosted",
      },
    };
  }
  const signingKey = secret(props.signingKey);
  refuseDevKey(createPrivateKey(pem(Redacted.value(signingKey))), "signingKey");
  return {
    client,
    env: {
      ...hosts,
      DISPLAY_NAME: client.name,
      SIGNING_KEY: signingKey,
      TABLETOP_MODE: "standalone",
      WORKOS_API_KEY: secret(props.workOs.apiKey),
      WORKOS_CLIENT_ID: props.workOs.clientId,
      ...(props.mcp === undefined ? {} : { MCP_RESOURCE: `https://${props.mcp.domain}/mcp` }),
    },
  };
}

/**
 * The client is built per deployment: it carries the host's pass endpoint,
 * the brand and tldraw's licence key, which tldraw checks against the domain.
 * @param {string} id
 * @param {import("../client/settings.ts").ClientSettings} settings
 * @param {string | undefined} iconsDir
 */
const buildClient = (id, settings, iconsDir) =>
  Effect.promise(async () => {
    const { build } = await import("vite");
    const outDir = resolve(".alchemy", "tabletop", id);
    await build({
      build: { outDir },
      configFile: packageFile("vite.config.ts"),
      define: { __TABLETOP__: JSON.stringify(settings) },
      logLevel: "warn",
      ...(iconsDir === undefined ? {} : { publicDir: resolve(iconsDir) }),
    });
    return outDir;
  });

/**
 * @param {string} id
 * @param {import("./index.js").TabletopProps} props
 */
export const Tabletop = (id, props) =>
  Effect.gen(function* () {
    const { client, env } = configure(props);
    const assets = yield* buildClient(id, client, props.iconsDir);
    // Standalone mode's accounts, sessions, boards and visits, and the
    // per-address rate limiter.
    const standalone =
      props.mode === "standalone"
        ? {
            DB: yield* Cloudflare.D1.Database(`${id}Accounts`, {
              migrations: packageFile("migrations"),
            }),
            Limiter: Cloudflare.DurableObject("Limiter"),
          }
        : {};
    // The boards' images, one bucket per deployment and stage (Alchemy
    // names it app-stage-id). NOTE: a bucket with objects in it is never
    // destroyed with the stack; the boards' images are not disposable.
    const files = yield* Cloudflare.R2.Bucket(`${id}Files`);
    const worker = yield* Cloudflare.Worker(id, {
      assets: {
        directory: assets,
        htmlHandling: "none",
        notFoundHandling: "none",
        // Every request meets the Worker first: aliases redirect, and pages
        // and files leave with the tabletop's headers.
        runWorkerFirst: true,
      },
      compatibility: {
        date: testedRuntime.compatibility_date,
        // NOTE: Alchemy switches Workers to the new module registry unless
        // told otherwise, and the tests run the legacy one this date
        // defaults to. nodejs_compat is on by default from 2026-08-04.
        flags: ["legacy_module_registry"],
      },
      // NOTE: the aliases are attached for DNS and TLS only; the Worker
      // answers each with a 308 to the primary host (src/site.ts).
      domain:
        props.domain === undefined
          ? undefined
          : { aliases: props.domain.aliases ?? [], name: props.domain.primary },
      env: {
        ...env,
        ...standalone,
        BoardRoom: Cloudflare.DurableObject("BoardRoom"),
        Files: files,
      },
      main: packageFile("src/index.ts"),
      name: props.workerName,
      observability,
    });
    // The MCP Worker, when the host asks for one: everything assistants
    // need (the MCP server, the ops engine, the text measurer and its
    // fonts) in a Worker of its own, so the board Worker stays small. It
    // reaches boards through the board Worker's BoardRoom class.
    const mcp =
      props.mcp === undefined
        ? undefined
        : yield* Cloudflare.Worker(`${id}Mcp`, {
            compatibility: {
              date: testedRuntime.compatibility_date,
              flags: ["legacy_module_registry"],
            },
            domain: props.mcp.domain === undefined ? undefined : { name: props.mcp.domain },
            env: {
              BoardRoom: Cloudflare.DurableObject("BoardRoom", { scriptName: worker.workerName }),
              MCP_AUTHORIZATION_SERVER: props.mcp.authorizationServer,
              ...(props.mode === "hosted"
                ? {
                    ISSUER: props.issuer,
                    ISSUER_PUBLIC_KEY: props.issuerPublicKey,
                    MCP_AUDIENCE: props.mcp.audience ?? "tabletop-mcp",
                  }
                : {
                    DB: standalone.DB,
                    MCP_BOARD_ORIGIN:
                      props.domain === undefined
                        ? new URL(worker.url).origin
                        : `https://${props.domain.primary}`,
                    MCP_RESOURCE: `https://${props.mcp.domain}/mcp`,
                  }),
            },
            main: packageFile("src/mcp/worker.ts"),
            name: props.mcp.workerName,
            observability,
          });
    return { files, mcp, url: worker.url, worker };
  });
