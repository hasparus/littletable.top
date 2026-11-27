import { createRoot, hydrateRoot } from "react-dom/client";

import type { Language } from "../settings";
import type { FrontCopy } from "./front-copy";

import { FrontApp, type FrontState } from "./front-app";
import { ASSISTANTS_SIGN_IN, type FrontView, loadFront } from "./front-page";

export async function mountFront(
  element: HTMLElement,
  { view, ...props }: { copy: FrontCopy; locale: Language; name: string; view: FrontView },
) {
  element.classList.add("overflow-y-auto", "bg-background");
  const state = document.getElementById("front-state");
  // WARNING: SAFETY: This must match the props that the Worker serializes for hydration.
  const parsed = state ? (JSON.parse(state.textContent!) as FrontState) : undefined;
  const initial = parsed?.page.view === view ? parsed : undefined;
  const page = initial?.page ?? (await loadFront(view));
  if (page === "signed-out") {
    location.assign(ASSISTANTS_SIGN_IN);
    return;
  }
  const app = <FrontApp {...props} page={page} />;
  if (initial?.locale === props.locale && initial.name === props.name) hydrateRoot(element, app);
  else createRoot(element).render(app);
}
