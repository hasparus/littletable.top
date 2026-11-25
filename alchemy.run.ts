import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { Tabletop } from "./alchemy/index.js";

// Little Table: this repository's own standalone copy, on a domain of its
// own (littletable.top in production). Stages prod and staging get custom
// domains (TABLETOP_DOMAIN, and staging.<it>) once it is set; until then,
// and for any other stage, a stage is on workers.dev. Each stage's WorkOS
// application must list https://<its host>/auth/callback as a redirect URI.
export default Alchemy.Stack(
  "LittleTable",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const domain = yield* Config.String("TABLETOP_DOMAIN").pipe(Config.withDefault(""));
    const primary = { prod: domain, staging: `staging.${domain}` }[stage];
    const projectToken = yield* Config.Redacted("POSTHOG_PROJECT_TOKEN").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const feedback =
      (stage === "prod" || stage === "staging") && Redacted.value(projectToken) !== ""
        ? {
            projectToken,
            region: yield* Config.String("POSTHOG_REGION"),
            surveyId: yield* Config.String("POSTHOG_FEEDBACK_SURVEY_ID"),
            questionId: yield* Config.String("POSTHOG_FEEDBACK_QUESTION_ID"),
          }
        : undefined;
    const mcpIssuer = yield* Config.String("MCP_AUTHKIT_ORIGIN").pipe(Config.withDefault(""));
    const mcpDomain = yield* Config.String("MCP_DOMAIN").pipe(Config.withDefault(""));
    if ((mcpIssuer === "") !== (mcpDomain === "")) {
      throw new Error("Set MCP_AUTHKIT_ORIGIN and MCP_DOMAIN together");
    }
    const tabletop = yield* Tabletop("Tabletop", {
      displayName: "Little Table",
      domain: primary === undefined || domain === "" ? undefined : { primary },
      feedback,
      licenseKey: yield* Config.String("TLDRAW_LICENSE_KEY").pipe(Config.withDefault("")),
      mode: "standalone",
      mcp:
        mcpIssuer === ""
          ? undefined
          : {
              authorizationServer: mcpIssuer,
              domain: mcpDomain,
              workerName: { prod: "littletable-mcp", staging: "littletable-mcp-staging" }[stage],
            },
      publicBoardOwnerId: yield* Config.String("PUBLIC_BOARD_OWNER_ID").pipe(
        Config.withDefault(""),
      ),
      signingKey: yield* Config.Redacted("TABLETOP_SIGNING_KEY"),
      workerName: { prod: "littletable", staging: "littletable-staging" }[stage],
      workOs: {
        apiKey: yield* Config.Redacted("WORKOS_API_KEY"),
        clientId: yield* Config.String("WORKOS_CLIENT_ID"),
      },
    });
    return { url: tabletop.url };
  }),
);
