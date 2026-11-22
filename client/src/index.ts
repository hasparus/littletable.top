import "./app.css";
import "virtual:tabletop-brand.css";
import type { ClientSettings, Language } from "../settings";

import { knock } from "./bootstrap";
import { COPY } from "./copy";

// NOTE: the build writes it (vite.config.ts, client/settings.ts).
declare const __TABLETOP__: ClientSettings;
const settings = __TABLETOP__;

const LANGUAGE_KEY = "board.language";
const isLanguage = (value: string | null): value is Language => value === "en" || value === "pl";

// The language the host had when it sent the person here (?lang=), then the
// browser's, then the deployment's own. The query leaves the address so a
// shared link does not carry it; the tab keeps it for a reload.
function pickLanguage(): Language {
  const url = new URL(location.href);
  const asked = url.searchParams.get("lang");
  if (isLanguage(asked)) {
    url.searchParams.delete("lang");
    history.replaceState(history.state, "", url);
    try {
      sessionStorage.setItem(LANGUAGE_KEY, asked);
    } catch {
      // NOTE: storage can be off; the language then holds for this load only.
    }
    return asked;
  }
  let kept: string | null = null;
  try {
    kept = sessionStorage.getItem(LANGUAGE_KEY);
  } catch {
    kept = null;
  }
  if (isLanguage(kept)) return kept;
  for (const tag of navigator.languages) {
    const primary = tag.split("-")[0]!.toLowerCase();
    if (isLanguage(primary)) return primary;
  }
  return settings.language;
}

const language = pickLanguage();
const copy = COPY[language];
document.documentElement.lang = language;
// NOTE: a host keeps a chosen theme in its own origin's storage, out of
// reach here; the board follows the device.
if (matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
}

const root = document.querySelector<HTMLElement>("[data-board-root]")!;
// The Worker serves this page only at /b/<share code>.
const shareCode = location.pathname.split("/")[2] ?? "";
const hosted = settings.hosted!;
const door = {
  bootstrapUrl: hosted.bootstrapUrl.replace("{code}", encodeURIComponent(shareCode)),
};

// The bootstrap request and tldraw's download run side by side: on a phone
// the canvas then opens one round trip sooner.
const first = knock(door);
const { mountBoard } = await import("./board");
mountBoard(root, {
  copy,
  door,
  fallbackExit: { href: hosted.exitUrl, label: copy.backToMain },
  first,
  language,
  licenseKey: settings.licenseKey,
});
