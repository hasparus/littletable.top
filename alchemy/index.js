// @ts-check
// WARNING: Alchemy transpiles the stack's TypeScript but loads this package directly in Node.

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildClient } from "./build-client.js";

// oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
const packageFile = (/** @type {string} */ path) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));

// oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
const pem = (/** @type {string} */ value) => value.replaceAll(String.raw`\n`, "\n");

// WARNING: Trusting the committed development key lets anyone mint passes for this deployment.
const devPublicKey = createPublicKey(
  readFileSync(packageFile("dev/dev-signing-key.pem"), "utf8"),
).export({ format: "der", type: "spki" });

// oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
/** @param {import("node:crypto").KeyObject} key @param {string} name */
function refuseDevKey(key, name) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  if (publicKey.export({ format: "der", type: "spki" }).equals(devPublicKey)) {
    throw new Error(`tabletop: ${name} is the committed development key`);
  }
}

// WARNING: Moving `issues` into the typed props literal fails type checking. Omitting it disables Workers Issues.
const observability = {
  enabled: true,
  issues: { enabled: true },
  logs: { enabled: true, invocationLogs: false },
};

// oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
/** @param {string | Redacted.Redacted<string>} value */
const secret = (value) => (Redacted.isRedacted(value) ? value : Redacted.make(value));

// oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
/** @param {string | Redacted.Redacted<string>} value */
function signingSecret(value) {
  const key = secret(value);
  refuseDevKey(createPrivateKey(pem(Redacted.value(key))), "signingKey");
  return key;
}

// oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
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
        LINK_RESET_AUDIENCE: props.linkResetAudience ?? "board-link-reset",
        PASS_AUDIENCE: props.passAudience ?? "board",
        TABLETOP_MODE: "hosted",
      },
    };
  }
  const signingKey = Output.isOutput(props.signingKey)
    ? props.signingKey.pipe(Output.map(signingSecret))
    : signingSecret(props.signingKey);
  const { feedback } = props;
  return {
    client,
    env: {
      ...hosts,
      DISPLAY_NAME: client.name,
      ...(feedback === undefined
        ? {}
        : {
            POSTHOG_FEEDBACK_QUESTION_ID: feedback.questionId,
            POSTHOG_FEEDBACK_SURVEY_ID: feedback.surveyId,
            POSTHOG_PROJECT_TOKEN: secret(feedback.projectToken),
            POSTHOG_REGION: feedback.region,
          }),
      SIGNING_KEY: signingKey,
      TABLETOP_MODE: "standalone",
      WORKOS_API_KEY: secret(props.workOs.apiKey),
      WORKOS_CLIENT_ID: props.workOs.clientId,
      PUBLIC_BOARD_OWNER_ID: props.publicBoardOwnerId ?? "",
    },
  };
}

/**
 * @param {string} id
 * @param {import("./index.js").TabletopProps} props
 */
export const Tabletop = (id, props) =>
  Effect.gen(function* () {
    const { prebuilt } = props;
    const sourceFile =
      prebuilt === undefined
        ? packageFile
        : // oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
          (/** @type {string} */ path) => resolve(prebuilt, path);
    // oxlint-disable-next-line landmines-style/no-comments -- TypeScript uses this JSDoc to check the JavaScript entry.
    /** @type {{ compatibility_date: string }} */
    const testedRuntime = JSON.parse(readFileSync(sourceFile("wrangler.json"), "utf8"));
    const { client, env } = configure(props);
    const assets =
      prebuilt === undefined ? resolve(".alchemy", "tabletop", id) : sourceFile("client");
    if (prebuilt === undefined) {
      yield* Effect.promise(() =>
        buildClient(packageFile("vite.config.ts"), assets, client, props.iconsDir),
      );
    }
    const standalone =
      props.mode === "standalone"
        ? {
            DB: yield* Cloudflare.D1.Database(`${id}Accounts`, {
              migrations: sourceFile("migrations"),
            }),
            Limiter: Cloudflare.DurableObject("Limiter"),
          }
        : {};
    const files = yield* Cloudflare.R2.Bucket(
      `${id}Files`,
      props.forceDestroyFiles ? { forceDestroy: true } : undefined,
    );
    const worker = yield* Cloudflare.Worker(id, {
      assets: {
        directory: assets,
        htmlHandling: "none",
        notFoundHandling: "none",
        // WARNING: Serving assets first would bypass alias redirects and app security headers.
        runWorkerFirst: true,
      },
      compatibility: {
        date: testedRuntime.compatibility_date,
        // WARNING: Alchemy otherwise selects a different module registry than the one Wrangler tests.
        flags:
          prebuilt === undefined
            ? ["legacy_module_registry"]
            : ["legacy_module_registry", "nodejs_compat"],
      },
      // WARNING: Domain aliases only attach DNS and TLS. The Worker must still redirect requests.
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
      ...(prebuilt === undefined
        ? { main: packageFile("src/index.ts") }
        : { bundle: false, main: sourceFile("worker/index.js") }),
      name: props.workerName,
      observability,
    });
    return { files, url: worker.url, worker };
  });
