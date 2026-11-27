import { createRoot, hydrateRoot } from "react-dom/client";

import type { Language } from "../settings";
import type { FrontCopy } from "./front-copy";

import { FrontApp, type FrontState, type FrontView } from "./front-app";

export function mountFront(
  element: HTMLElement,
  props: { copy: FrontCopy; locale: Language; name: string; view: FrontView },
) {
  element.classList.add("overflow-y-auto", "bg-background");
  const state = document.getElementById("front-state");
  // WARNING: SAFETY: This must match the props that the Worker serializes for hydration.
  const initial = state ? (JSON.parse(state.textContent!) as FrontState) : undefined;
  const app =
    props.view === "boards" ? (
      <FrontApp
        {...props}
        failed={new URL(location.href).searchParams.get("sign-in") === "failed"}
        initialPage={initial?.view === "boards" ? initial.initialPage : undefined}
        view="boards"
      />
    ) : (
      <FrontApp
        {...props}
        initialPage={initial?.view === "assistants" ? initial.initialPage : undefined}
        view="assistants"
      />
    );
  if (
    initial?.view === props.view &&
    initial.locale === props.locale &&
    initial.name === props.name
  ) {
    hydrateRoot(element, app);
  } else createRoot(element).render(app);
}
