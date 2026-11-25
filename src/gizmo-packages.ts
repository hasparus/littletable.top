import { T } from "@tldraw/validate";

const SEGMENT = /^[a-zA-Z\d][a-zA-Z\d_.-]{0,79}$/u;
const RASTER = /\.(?:png|webp|jpeg|jpg)$/iu;
const SOURCE =
  /^https:\/\/github\.com\/([a-zA-Z\d][a-zA-Z\d-]{0,38})\/([a-zA-Z\d][a-zA-Z\d_.-]{0,99})\/blob\/([\da-fA-F]{40})\/(.+)$/u;
const LOCAL_ASSET = /^\/gizmos\/([a-z\d_-]+)\/(.+)$/u;
const PINNED_ASSET = /^\/rooms\/[\w-]{1,64}\/gizmo-assets\/[\da-f]{64}\/(.+)$/u;

function safePath(value: string) {
  return (
    value.length <= 240 &&
    value.split("/").every((part) => SEGMENT.test(part)) &&
    !/\s/u.test(value)
  );
}

export function isPackageAssetPath(path: string) {
  return safePath(path) && RASTER.test(path);
}

const hostAsset = T.string.check((url) => {
  const path = PINNED_ASSET.exec(url)?.[1] ?? LOCAL_ASSET.exec(url)?.[2];
  if (!path || !isPackageAssetPath(path) || /\s/u.test(url)) throw new Error("Invalid Gizmo asset");
});
export const isGizmoAssetUrl = hostAsset.isValid.bind(hostAsset);
export const gizmoInstallRequest = T.object({ url: T.string });

export const gizmoDecision = T.object({
  action: T.literalEnum("approve", "decline"),
  id: T.positiveInteger,
});
export type GizmoDecision = T.TypeOf<typeof gizmoDecision>;
export type GizmoRequest = {
  id: number;
  url: string;
  status: "pending" | "installed" | "declined";
  requesters: string[];
  installedUrl?: string;
};

/** Normalize folder and manifest links locally, before the owner authorizes a download. */
export function normalizeGizmoLink(input: string) {
  if (input.length > 450) return null;
  const match =
    /^https:\/\/github\.com\/([a-zA-Z\d][a-zA-Z\d-]{0,38})\/([a-zA-Z\d][a-zA-Z\d_.-]{0,99})\/(tree|blob)\/(.+)$/u.exec(
      input.trim(),
    );
  if (!match) return null;
  const [, owner, repo, view, target] = match;
  const path = view === "tree" ? target!.replace(/\/$/u, "") + "/gizmo.json" : target!;
  const url =
    "https://github.com/" + owner!.toLowerCase() + "/" + repo!.toLowerCase() + "/blob/" + path;
  const pinned = gizmoSource(url);
  if (pinned) return pinned.url;
  return safePath(path) && path.endsWith("/gizmo.json") ? url : null;
}

/** Both outbound targets and persisted identities originate from this restricted grammar. */
export function gizmoSource(input: string) {
  if (input.length > 450 || /\s/u.test(input)) return null;
  const match = SOURCE.exec(input);
  if (!match) return null;
  const [, owner, repo, revision, path] = match;
  if (!safePath(path) || !(path === "gizmo.json" || path.endsWith("/gizmo.json"))) return null;
  const project = owner!.toLowerCase() + "/" + repo!.toLowerCase();
  const sha = revision!.toLowerCase();
  const raw = "https://raw.githubusercontent.com/" + project + "/" + sha + "/";
  return {
    url: "https://github.com/" + project + "/blob/" + sha + "/" + path,
    rawManifest: raw + path,
    rawDirectory: raw + path.slice(0, -"gizmo.json".length),
  };
}

const label = T.string.check((text) => {
  if (text.length > 100 || text.trim().length === 0 || /[\p{Cc}\p{Cf}]/u.test(text))
    throw new Error("Invalid Gizmo name");
});
const name = T.object({ en: label, pl: label });
const dimension = T.integer.check((size) => {
  if (size < 1 || size > 4096) throw new Error("Invalid Gizmo dimensions");
});
const art = T.string.check((path) => {
  if (!isPackageAssetPath(path)) throw new Error("Invalid package art path");
});
export const trackerLayout = T.literalEnum("rail", "sliders", "initiative");
export type TrackerLayout = T.TypeOf<typeof trackerLayout>;

function manifestSchema(art: T.Validator<string>) {
  const card = T.object({
    id: T.string.check((id) => {
      if (!/^[a-zA-Z0-9][\w-]{0,47}$/u.test(id) || /\s/u.test(id))
        throw new Error("Invalid card ID");
    }),
    name,
    src: art,
    width: dimension,
  });
  const common = { version: T.literal(1), name, preview: art, width: dimension, height: dimension };
  const deck = T.object({
    ...common,
    kind: T.literal("deck"),
    back: art,
    backWidth: dimension,
    cardHeight: dimension,
    cards: T.arrayOf(card).check((cards) => {
      if (
        cards.length === 0 ||
        cards.length > 128 ||
        new Set(cards.map((item) => item.id)).size !== cards.length
      )
        throw new Error("Invalid deck");
    }),
  });
  return T.union("kind", {
    deck,
    tracker: T.object({
      ...common,
      kind: T.literal("tracker"),
      layout: trackerLayout.optional(),
      token: art.optional(),
      portraits: T.arrayOf(art)
        .check((images) => {
          if (images.length > 24) throw new Error("Too many portraits");
        })
        .optional(),
    }),
    button: T.object({
      ...common,
      kind: T.literal("button"),
      burst: art.optional(),
      effect: T.literalEnum("shake", "none").optional(),
    }),
  });
}

const packageSchema = manifestSchema(art);
export const installedManifestSchema = manifestSchema(hostAsset);

export type GizmoName = T.TypeOf<typeof name>;
export type GizmoManifest = T.TypeOf<typeof packageSchema>;
export type DeckManifest = Extract<GizmoManifest, { kind: "deck" }>;
export type DeckCard = DeckManifest["cards"][number];
export type InstalledGizmo = { url: string; manifest: GizmoManifest };

export function normalizeManifest(
  value: Parameters<typeof packageSchema.validate>[0],
  resolveAsset: (path: string) => string,
) {
  const manifest = packageSchema.validate(value);
  const preview = resolveAsset(manifest.preview);
  if (manifest.kind === "tracker")
    return {
      ...manifest,
      preview,
      ...(manifest.token && { token: resolveAsset(manifest.token) }),
      ...(manifest.portraits && { portraits: manifest.portraits.map(resolveAsset) }),
    };
  if (manifest.kind === "button" && manifest.burst)
    return { ...manifest, preview, burst: resolveAsset(manifest.burst) };
  if (manifest.kind !== "deck") return { ...manifest, preview };
  return {
    ...manifest,
    preview,
    back: resolveAsset(manifest.back),
    cards: manifest.cards.map((item) => ({ ...item, src: resolveAsset(item.src) })),
  };
}
