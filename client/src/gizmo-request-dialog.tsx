import { useEffect, useId, useRef, useState } from "react";

import type { GizmoRequest } from "../../src/gizmo-packages";

import registry from "../../gizmos/registry.json";
import { normalizeGizmoLink } from "../../src/gizmo-packages";
import { useGizmoUi } from "./gizmo-ui";
import { Icon } from "./icons";
import "./gizmo-drawer.css";

export function GizmoRequestDialog({
  entry,
  onDecision,
  onDismiss,
}: {
  entry: GizmoRequest;
  onDecision: (action: "approve" | "decline") => Promise<void>;
  onDismiss: () => void;
}) {
  const { copy, locale } = useGizmoUi();
  const source = normalizeGizmoLink(entry.url);
  const official = registry.find((listing) => listing.url === source);
  const language = locale === "pl" ? "pl" : "en";
  const [owner, repo, , ...target] = source?.slice("https://github.com/".length).split("/") ?? [];
  const name = official?.name[language] ?? (target.length > 2 ? target.at(-2) : repo);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const surface = dialog.current;
    if (!surface) return;
    const trigger = document.activeElement;
    surface.showModal();
    return () => {
      surface.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  async function decide(action: "approve" | "decline") {
    setPending(true);
    setFailed(false);
    try {
      await onDecision(action);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      data-gizmo-review
      aria-labelledby={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onDismiss();
      }}
    >
      <header>
        <h2 id={title}>{copy.gizmoReview}</h2>
        <button type="button" aria-label={copy.close} onClick={onDismiss} disabled={pending}>
          <Icon name="Close" />
        </button>
      </header>
      {name && <h3>{name}</h3>}
      {source && !official && (
        <p data-gizmo-review-source>
          <span>
            {owner}/{repo}
          </span>
          <span>{target.join("/")}</span>
        </p>
      )}
      <p>
        {copy.gizmoRequesters} <b>{entry.requesters.join(", ")}</b>
      </p>
      {source && (
        <a href={source} target="_blank" rel="noreferrer">
          {copy.gizmoViewCode}
        </a>
      )}
      {failed && <p role="alert">{copy.gizmoDecisionFailed}</p>}
      <footer aria-busy={pending}>
        <button
          type="button"
          data-gizmo-market-action
          disabled={pending}
          onClick={() => void decide("decline")}
        >
          {copy.gizmoDecline}
        </button>
        <button
          type="button"
          data-gizmo-market-action
          disabled={pending}
          onClick={() => void decide("approve")}
        >
          {copy.gizmoInstall}
        </button>
      </footer>
    </dialog>
  );
}
