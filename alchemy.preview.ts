import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { previewAccounts } from "./alchemy.preview-db.ts";
import { Tabletop } from "./alchemy/index.js";

// A separate stack name keeps PR teardown scoped to preview state. Preview
// Workers use workers.dev, with a fixed prefix for WorkOS Staging redirects.
export default Alchemy.Stack(
  "LittleTablePreview",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      GitHub.providers(),
      Alchemy.KeyPairProvider(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const github = yield* GitHub.GitHubEnv;
    if (github?.pr === undefined || stage !== `pr-${github.pr}`) {
      return yield* Effect.die(new Error("Deploy this stack with the PR Preview workflow."));
    }

    const legacyDatabase = yield* Config.String("PREVIEW_LEGACY_DATABASE_NAME").pipe(
      Config.withDefault(""),
    );
    if (legacyDatabase !== "") {
      yield* Cloudflare.D1.Database("TabletopAccounts", { name: legacyDatabase }).pipe(
        RemovalPolicy.retain(),
      );
    }

    const prebuilt = yield* Config.String("PREVIEW_BUNDLE_DIR");
    const issuer = yield* Config.String("MCP_AUTHKIT_ORIGIN").pipe(Config.withDefault(""));
    const baseDomain = yield* Config.String("MCP_DOMAIN").pipe(Config.withDefault(""));
    let mcp: { authorizationServer: string; domain: string; workerName: string } | undefined;
    if (existsSync(resolve(prebuilt, "mcp/index.js")) && (issuer !== "" || baseDomain !== "")) {
      if (issuer === "" || baseDomain === "") {
        return yield* Effect.die(
          new Error("Set preview MCP_AUTHKIT_ORIGIN and MCP_DOMAIN together."),
        );
      }
      const issuerUrl = URL.canParse(issuer) ? new URL(issuer) : undefined;
      if (issuerUrl?.protocol !== "https:" || issuerUrl.origin !== issuer) {
        return yield* Effect.die(
          new Error("Set preview MCP_AUTHKIT_ORIGIN to the HTTPS issuer origin."),
        );
      }
      const domain = `${stage}.${baseDomain}`;
      const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
      if (
        domain.length > 253 ||
        !baseDomain.includes(".") ||
        !domain.split(".").every((label) => hostnameLabel.test(label))
      ) {
        return yield* Effect.die(
          new Error("Set preview MCP_DOMAIN to the base hostname for PR subdomains."),
        );
      }
      mcp = { authorizationServer: issuer, domain, workerName: `littletable-mcp-${stage}` };
    }

    const signing = yield* Alchemy.KeyPair("SigningKey", { algorithm: "rsa" });
    const { url } = yield* Tabletop("Tabletop", {
      boardDataScope: stage,
      database: yield* previewAccounts(),
      displayName: "Little Table",
      forceDestroyFiles: true,
      mcp,
      mode: "standalone",
      prebuilt,
      signingKey: signing.privateKey,
      workerName: `littletable-${stage}`,
      workOs: {
        apiKey: yield* Config.Redacted("WORKOS_API_KEY"),
        clientId: yield* Config.String("WORKOS_CLIENT_ID"),
      },
    });

    const commit = yield* Config.String("PREVIEW_COMMIT");
    yield* GitHub.Comment("PreviewComment", {
      owner: github.owner,
      repository: github.repository,
      issueNumber: github.pr,
      allowDelete: true,
      body: Output.interpolate`
        ## Little Table preview

        [Open the preview](${url})${mcp === undefined ? "" : `\n\n[MCP endpoint](https://${mcp.domain}/mcp)`}

        Built from \`${commit.slice(0, 7)}\`.
      `,
    });
    return { url };
  }),
);
