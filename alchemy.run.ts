import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { Tabletop } from "./alchemy/index.js";

// The tabletop's own standalone copy, on a domain of its own. Stages prod
// and staging get custom domains (TABLETOP_DOMAIN, and staging.<it>); any
// other stage is a preview on workers.dev. Each stage's WorkOS application
// must list https://<its host>/auth/callback as a redirect URI.
export default Alchemy.Stack(
  "Tabletop",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const domain = yield* Config.String("TABLETOP_DOMAIN").pipe(Config.withDefault(""));
    const primary = { prod: domain, staging: `staging.${domain}` }[stage];
    const tabletop = yield* Tabletop("Tabletop", {
      domain: primary === undefined || domain === "" ? undefined : { primary },
      licenseKey: yield* Config.String("TLDRAW_LICENSE_KEY").pipe(Config.withDefault("")),
      mode: "standalone",
      signingKey: yield* Config.Redacted("TABLETOP_SIGNING_KEY"),
      workerName: { prod: "tabletop", staging: "tabletop-staging" }[stage],
      workOs: {
        apiKey: yield* Config.Redacted("WORKOS_API_KEY"),
        clientId: yield* Config.String("WORKOS_CLIENT_ID"),
      },
    });
    return { url: tabletop.url };
  }),
);
