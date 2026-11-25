import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

const stack = "LittleTablePreviewDatabase";
const stage = "staging";
const id = "Accounts";

export const previewAccounts = () => Cloudflare.D1.Database.ref(id, { stack, stage });

export default Alchemy.Stack(
  stack,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    if ((yield* Alchemy.Stage) !== stage) {
      return yield* Effect.die(new Error("Deploy the shared D1 stack only to staging."));
    }

    const database = yield* Cloudflare.D1.Database(id, {
      name: "littletable-preview-accounts",
      migrations: "./migrations",
    }).pipe(RemovalPolicy.retain());

    return { databaseId: database.databaseId };
  }),
);
