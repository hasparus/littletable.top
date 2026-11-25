import type * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import type { Brand, Language } from "../client/settings.ts";

export type { Brand, Language } from "../client/settings.ts";

type Shared = {
  brand?: Partial<Brand>;
  /** The name and description on the page, the home screen and the manifest. */
  description?: string;
  displayName?: string;
  /** Opt in for disposable deployments whose image buckets can be emptied on destroy. */
  forceDestroyFiles?: boolean;
  /**
   * The primary host and the hosts that 308 to it, attached as the Worker's
   * custom domains. Omit for a workers.dev preview.
   */
  domain?: { aliases?: string[]; primary: string };
  /**
   * A directory with favicon.svg, apple-touch-icon.png, icon-192.png,
   * icon-512.png, icon-1024.png and icon-maskable-512.png, in place of the
   * neutral ones.
   */
  iconsDir?: string;
  /** The language when neither the address nor the browser names one. */
  language?: Language;
  /** tldraw's licence key, built into the client: public by design. */
  licenseKey?: string;
  shortName?: string;
  /** Directory with compiled client assets, Worker, database migrations, and runtime metadata. */
  prebuilt?: string;
  /** The Worker's script name; Alchemy derives one from the stack otherwise. */
  workerName?: string;
};

export type HostedProps = Shared & {
  mode: "hosted";
  /** The `iss` of the host's passes. */
  issuer: string;
  /** The host's SPKI PEM public key. `\n` escapes are allowed and the committed dev key is refused. */
  issuerPublicKey: string;
  /** The deletion token audience. Defaults to `"board-deletion"`. */
  deletionAudience?: string;
  /** The link reset token audience. Defaults to `"board-link-reset"`. */
  linkResetAudience?: string;
  /** The pass audience. Defaults to `"board"`. */
  passAudience?: string;
  /** The host's origin; the client asks it for passes and the policy allows it. */
  hostOrigin: string;
  /**
   * The pass endpoint's path on hostOrigin; "{code}" is the share code.
   * Default: "/b/{code}/bootstrap/".
   */
  bootstrapPath?: string;
  /** Where the bare name and an unexplained exit lead. Default: hostOrigin. */
  exitUrl?: string;
  homeUrl?: string;
};

export type StandaloneProps = Shared & {
  /** Stable board metadata partition when the database is shared across preview Workers. */
  boardDataScope?: string;
  /** Bind an existing D1 resource. Its owning stack provisions and migrates it. */
  database?: Cloudflare.D1.Database;
  feedback?: {
    projectToken: Redacted.Redacted<string> | string;
    questionId: string;
    region: string;
    surveyId: string;
  };
  mode: "standalone";
  /**
   * The private key (PKCS#8 PEM) the Worker signs its own passes with. The
   * committed dev key is refused.
   */
  signingKey: Output.Output<Redacted.Redacted<string>> | Redacted.Redacted<string> | string;
  /**
   * The WorkOS application people sign in through: its client id and API
   * key. Its redirect URI is https://<domain.primary>/auth/callback.
   */
  workOs: { apiKey: Redacted.Redacted<string> | string; clientId: string };
};

export type TabletopProps = HostedProps | StandaloneProps;

export type Tabletop = {
  files: Cloudflare.R2.Bucket;
  url: Cloudflare.Worker["url"];
  worker: Cloudflare.Worker;
};

export declare function Tabletop(
  id: string,
  props: TabletopProps,
): Effect.Effect<Tabletop, never, Cloudflare.Providers>;
