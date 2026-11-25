import "./app.css";
import "virtual:tabletop-brand.css";
import type { ClientSettings, Language } from "../settings";

import { type Door, knock } from "./bootstrap";
import { COPY, fill } from "./copy";
import { FRONT_COPY, LANDING_COPY } from "./front-copy";
import { landingPreview } from "./landing-preview";

declare const __TABLETOP__: ClientSettings;
const settings = __TABLETOP__;

const LANGUAGE_KEY = "board.language";
const isLanguage = (value: string | null): value is Language => value === "en" || value === "pl";

// WARNING: Strip the language query so shared links do not carry the sender's preference.
function pickLanguage(): Language {
  const url = new URL(location.href);
  const asked = url.searchParams.get("lang");
  if (isLanguage(asked)) {
    url.searchParams.delete("lang");
    history.replaceState(history.state, "", url);
    try {
      sessionStorage.setItem(LANGUAGE_KEY, asked);
    } catch {
      // WARNING: When sessionStorage is unavailable, the language query applies to this load only.
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

const isPublic = settings.hosted === null && location.pathname === "/";
const preferredLanguage = pickLanguage();
const language = isPublic ? "en" : preferredLanguage;
const copy = COPY[language];
document.documentElement.lang = language;
// WARNING: The board cannot read the host’s storage across origins. Use the device theme instead.
if (matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
}

const root = document.querySelector<HTMLElement>("[data-board-root]")!;
async function mount(): Promise<void> {
  if (settings.hosted === null && location.pathname === "/boards") {
    const { mountFront } = await import("./front");
    mountFront(root, { copy: FRONT_COPY[language], locale: language, name: settings.name });
    return;
  }
  const landing = isPublic ? { copy: LANDING_COPY } : undefined;
  const shareCode = encodeURIComponent(location.pathname.split("/")[2] ?? "");
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

  // WARNING: Keep the bootstrap request and editor download concurrent to avoid delaying the canvas.
  const first = knock(door);
  if (landing) {
    const classes = document.documentElement.classList;
    const reveal = () => classes.remove("loading-handwriting");
    classes.add("loading-handwriting");
    void document.fonts.load('15px "Landing handwriting"').then(reveal, reveal);
    root.replaceChildren(landingPreview(landing.copy));
  }
  const { mountBoard } = await import("./board");
  mountBoard(root, {
    copy,
    door,
    fallbackExit,
    feedback: settings.mode === "standalone",
    first,
    landing,
    language,
    licenseKey: settings.licenseKey,
  });
}

await mount();
