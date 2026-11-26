import { useId, useRef, useState } from "react";

import { type GizmoSubmission, normalizeGizmoLink } from "../../src/gizmo-packages";
import { useGizmoUi } from "./gizmo-ui";

async function sendForReview(url: string) {
  try {
    const result = await fetch("/api/gizmo-submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(15_000),
    });
    const receipt: GizmoSubmission | null = result.ok ? await result.json() : null;
    return { status: result.status, receipt };
  } catch {
    return { status: 0, receipt: null };
  }
}

export function GizmoSubmit({
  board,
  action,
  online,
  busy,
  submit,
}: {
  board: boolean;
  action: string;
  online: boolean;
  busy: boolean;
  submit: (url: string) => Promise<boolean>;
}) {
  const { copy } = useGizmoUi();
  const id = useId();
  const [destination, setDestination] = useState<"board" | "public">("board");
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error?: boolean;
    link?: { label: string; url: string };
  } | null>(null);
  const publicListing = !board || destination === "public";
  async function send(url: string, input: HTMLInputElement) {
    if (publicListing) {
      const { receipt, status } = await sendForReview(url);
      if (!receipt) {
        setMessage({
          text:
            status === 429
              ? copy.tooManyTries
              : status === 404
                ? copy.gizmoRevisionMissing
                : copy.gizmoSubmissionFailed,
          error: true,
        });
      } else if (receipt.status === "confirm") {
        setMessage({
          text: copy.gizmoConfirmHelp,
          link: { label: copy.gizmoConfirmGitHub, url: receipt.url },
        });
      } else {
        input.value = "";
        setMessage(
          receipt.status === "listed"
            ? { text: copy.gizmoAlreadyListed }
            : {
                text: copy.gizmoSubmitted,
                link: { label: copy.gizmoTrackReview, url: receipt.url },
              },
        );
      }
    } else if (await submit(url)) input.value = "";
  }
  return (
    <form
      data-gizmo-install
      onChange={() => setMessage(null)}
      onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current || busy || !online) return;
        const input = event.currentTarget.elements.namedItem("source");
        if (!(input instanceof HTMLInputElement)) return;
        const url = normalizeGizmoLink(input.value.trim());
        if (!url) {
          setMessage({ text: copy.gizmoSourceHelp, error: true });
          return;
        }
        inFlight.current = true;
        setSending(true);
        setMessage(null);
        await send(url, input)
          .catch(() => setMessage({ text: copy.gizmoSubmissionFailed, error: true }))
          .finally(() => {
            inFlight.current = false;
            setSending(false);
          });
      }}
    >
      <label htmlFor={id}>{copy.gizmoSource}</label>
      <input
        data-gizmo-source-input
        id={id}
        name="source"
        type="url"
        autoComplete="off"
        spellCheck={false}
        required
        disabled={sending || busy}
        aria-describedby={id + "-help"}
        placeholder="https://github.com/…"
      />
      <div data-gizmo-submit-actions>
        {board ? (
          <select
            aria-label={copy.gizmoDestination}
            value={destination}
            disabled={sending || busy}
            onChange={(event) =>
              setDestination(event.target.value === "public" ? "public" : "board")
            }
          >
            <option value="board">{copy.gizmoThisBoard}</option>
            <option value="public">{copy.gizmoPublicMarketplace}</option>
          </select>
        ) : (
          <span>{copy.gizmoPublicMarketplace}</span>
        )}
        <button data-gizmo-market-action type="submit" disabled={!online || busy || sending}>
          {sending ? copy.loading : publicListing ? copy.gizmoSubmitForReview : action}
        </button>
      </div>
      <p id={id + "-help"}>
        {publicListing
          ? board
            ? copy.gizmoPublicReviewHelp
            : copy.gizmoPracticeSubmitHelp
          : copy.gizmoSourceHelp}
      </p>
      {message && (
        <p role={message.error ? "alert" : "status"}>
          {message.text}
          {message.link && (
            <>
              {" "}
              <a href={message.link.url} target="_blank" rel="noreferrer">
                {message.link.label}
              </a>
            </>
          )}
        </p>
      )}
    </form>
  );
}
