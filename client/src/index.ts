import "./app.css";
import "virtual:tabletop-brand.css";
import type { ClientSettings, Language } from "../settings";

import { type Door, knock } from "./bootstrap";
import { COPY, fill } from "./copy";
import { FRONT_COPY } from "./front-copy";

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
// Standalone mode also has the public board at / and the account at /boards.
async function mount(): Promise<void> {
  if (settings.hosted === null && location.pathname === "/boards") {
    const { mountFront } = await import("./front");
    mountFront(root, { copy: FRONT_COPY[language], locale: language, name: settings.name });
    return;
  }
  const isPublic = settings.hosted === null && location.pathname === "/";
  const landing = isPublic ? { copy: FRONT_COPY[language] } : undefined;
  const shareCode = encodeURIComponent(location.pathname.split("/")[2] ?? "");
  // Hosted, the host signs passes across origins with its own cookie;
  // standalone, this Worker does, on its own origin.
  const door: Door =
    settings.hosted === null
      ? {
          bootstrapUrl: isPublic ? "/api/public-board/bootstrap" : `/api/b/${shareCode}/bootstrap`,
          credentials: "same-origin",
        }
      : {
          bootstrapUrl: settings.hosted.bootstrapUrl.replace("{code}", shareCode),
          credentials: "include",
        };
  const fallbackExit =
    settings.hosted === null
      ? { href: "/", label: fill(copy.backTo, { home: settings.name }) }
      : { href: settings.hosted.exitUrl, label: copy.backToMain };

  // The bootstrap request and tldraw's download run side by side: on a
  // phone the canvas then opens one round trip sooner.
  const first = knock(door);
  const { mountBoard } = await import("./board");
  mountBoard(root, {
    copy,
    door,
    fallbackExit,
    first,
    landing,
    language,
    licenseKey: settings.licenseKey,
  });
}

await mount();
