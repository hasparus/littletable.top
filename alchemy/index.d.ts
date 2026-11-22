import type * as Cloudflare from "@alchemy.run/cloudflare";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import type { Brand, Language } from "../client/settings.ts";

export type { Brand, Language } from "../client/settings.ts";

type Shared = {
  brand?: Partial<Brand>;
  // The name and description on the page, the home screen and the manifest.
  description?: string;
  displayName?: string;
  // The primary host and the hosts that 308 to it, attached as the Worker's
  // custom domains. Omit for a workers.dev preview.
  domain?: { aliases?: string[]; primary: string };
  // A directory with favicon.svg, apple-touch-icon.png, icon-192.png,
  // icon-512.png, icon-1024.png and icon-maskable-512.png, in place of the
  // neutral ones.
  iconsDir?: string;
  // The language when neither the address nor the browser names one.
  language?: Language;
  // tldraw's licence key, built into the client: public by design.
  licenseKey?: string;
  shortName?: string;
  // The Worker's script name; Alchemy derives one from the stack otherwise.
  workerName?: string;
};

export type HostedProps = Shared & {
  mode: "hosted";
  // The `iss` of the host's passes, and the public half of its key (SPKI
  // PEM; "\n" escapes allowed). The committed dev key is refused.
  issuer: string;
  issuerPublicKey: string;
  // Defaults: "board" and "board-deletion".
  deletionAudience?: string;
  passAudience?: string;
  // The host's origin; the client asks it for passes and the policy allows it.
  hostOrigin: string;
  // The pass endpoint's path on hostOrigin; "{code}" is the share code.
  // Default: "/b/{code}/bootstrap/".
  bootstrapPath?: string;
  // Where the bare name and an unexplained exit lead. Default: hostOrigin.
  exitUrl?: string;
  homeUrl?: string;
};

export type StandaloneProps = Shared & {
  mode: "standalone";
  // The private key (PKCS#8 PEM) the Worker signs its own passes with.
  signingKey: Redacted.Redacted<string> | string;
};

export type TabletopProps = HostedProps | StandaloneProps;

export type Tabletop = {
  url: Cloudflare.Worker["url"];
  worker: Cloudflare.Worker;
};

export declare function Tabletop(
  id: string,
  props: TabletopProps,
): Effect.Effect<Tabletop, never, Cloudflare.Providers>;
