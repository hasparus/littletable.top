import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

    const signing = yield* Alchemy.KeyPair("SigningKey", { algorithm: "rsa" });
    const { url } = yield* Tabletop("Tabletop", {
      displayName: "Little Table",
      forceDestroyFiles: true,
      mode: "standalone",
      prebuilt: yield* Config.String("PREVIEW_BUNDLE_DIR"),
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

        [Open the preview](${url})

        Built from \`${commit.slice(0, 7)}\`.
      `,
    });
    return { url };
  }),
);
