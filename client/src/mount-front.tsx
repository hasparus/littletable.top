import type { ComponentProps } from "react";

import { createRoot, hydrateRoot } from "react-dom/client";

import type { Language } from "../settings";
import type { FrontCopy } from "./front-copy";

import { BoardsApp } from "./front";

export function mountFront(
  element: HTMLElement,
  props: { copy: FrontCopy; locale: Language; name: string },
) {
  element.classList.add("overflow-y-auto", "bg-background");
  const state = document.getElementById("boards-state");
  // WARNING: SAFETY: This must match the props that the Worker serializes for hydration.
  const initial = state
    ? (JSON.parse(state.textContent!) as Omit<ComponentProps<typeof BoardsApp>, "copy">)
    : undefined;
  const app = (
    <BoardsApp
      {...props}
      failed={new URL(location.href).searchParams.get("sign-in") === "failed"}
      initialPage={initial?.initialPage}
    />
  );
  if (initial?.locale === props.locale && initial.name === props.name) hydrateRoot(element, app);
  else createRoot(element).render(app);
}
