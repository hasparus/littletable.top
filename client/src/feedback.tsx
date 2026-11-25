import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { Language } from "../settings";

const COPY = {
  en: {
    bug: "Report a bug",
    cancel: "Cancel",
    description: "Description",
    done: "Done",
    error: "Couldn’t send your feedback. Please try again.",
    hint: "Tell us what happened or what you’d like to change. Leave out private details.",
    improvement: "Suggest an improvement",
    kind: "What is your feedback about?",
    limited: "Too many reports in a short time. Please try again in a minute.",
    send: "Send",
    sending: "Sending…",
    thanks: "Thanks for the feedback!",
    title: "Send feedback",
  },
  pl: {
    bug: "Zgłoś błąd",
    cancel: "Anuluj",
    description: "Opis",
    done: "Gotowe",
    error: "Nie udało się wysłać opinii. Spróbuj ponownie.",
    hint: "Opisz, co się stało lub co chcesz zmienić. Pomiń dane prywatne.",
    improvement: "Zaproponuj ulepszenie",
    kind: "Czego dotyczy Twoja opinia?",
    limited: "Zbyt wiele zgłoszeń w krótkim czasie. Spróbuj ponownie za minutę.",
    send: "Wyślij",
    sending: "Wysyłanie…",
    thanks: "Dziękujemy za opinię!",
    title: "Prześlij opinię",
  },
};

type Source = { role: "guest" | "member"; screen: "board" } | { role: "member"; screen: "boards" };
type FeedbackControls = {
  label: string;
  open: (source: Source, trigger?: HTMLElement | null) => void;
};
const FeedbackContext = createContext<FeedbackControls | null>(null);

export function useFeedback() {
  return useContext(FeedbackContext);
}

export function FeedbackProvider({
  children,
  enabled,
  language,
}: {
  children: ReactNode;
  enabled: boolean;
  language: Language;
}) {
  const [available, setAvailable] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch("/api/feedback", { signal: controller.signal }).then(
      (response) => setAvailable(response.status === 204),
      () => setAvailable(false),
    );
    return () => controller.abort();
  }, [enabled]);

  const copy = COPY[language];
  return (
    <FeedbackContext.Provider
      value={
        enabled && available
          ? {
              label: copy.title,
              open: (openedFrom, trigger = null) => {
                returnFocus.current = trigger;
                setSource(openedFrom);
              },
            }
          : null
      }
    >
      {children}
      {source !== null && (
        <FeedbackDialog
          copy={copy}
          onClose={() => {
            setSource(null);
            returnFocus.current?.focus();
          }}
          source={source}
        />
      )}
    </FeedbackContext.Provider>
  );
}

function FeedbackDialog({
  copy,
  onClose,
  source,
}: {
  copy: (typeof COPY)[Language];
  onClose: () => void;
  source: Source;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const previous = useRef<{ category: string; description: string; submissionId: string } | null>(
    null,
  );
  const [status, setStatus] = useState<"error" | "limited" | "ready" | "sending" | "sent">("ready");
  const [description, setDescription] = useState("");
  const heading = useId();
  const field = useId();
  const hint = useId();
  const sending = status === "sending";

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (status === "sent") done.current?.focus();
  }, [status]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = description.trim();
    if (sending || trimmed === "") return;
    const category = String(new FormData(event.currentTarget).get("category"));
    const last = previous.current;
    const submission =
      last?.category === category && last.description === trimmed
        ? last
        : { category, description: trimmed, submissionId: crypto.randomUUID() };
    previous.current = submission;
    setStatus("sending");
    try {
      const response = await fetch("/api/feedback", {
        body: JSON.stringify({ ...source, ...submission }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(12_000),
      });
      setStatus(response.status === 204 ? "sent" : response.status === 429 ? "limited" : "error");
    } catch {
      setStatus("error");
    }
  }

  return (
    <dialog
      aria-labelledby={heading}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-border bg-background p-5 text-foreground sm:p-6"
      data-feedback-dialog
      onCancel={(event) => {
        if (sending) event.preventDefault();
      }}
      onClose={onClose}
      ref={dialog}
    >
      <h2 className="text-xl font-semibold" id={heading}>
        {copy.title}
      </h2>
      {status === "sent" ? (
        <>
          <p className="mt-3 text-foreground-secondary" role="status">
            {copy.thanks}
          </p>
          <div className="mt-5 flex justify-end">
            <button
              className="btn btn-primary min-h-11"
              onClick={() => dialog.current?.close()}
              ref={done}
              type="button"
            >
              {copy.done}
            </button>
          </div>
        </>
      ) : (
        <form className="mt-4" onSubmit={(event) => void submit(event)}>
          <fieldset disabled={sending}>
            <legend className="mb-2 text-sm font-medium">{copy.kind}</legend>
            <div className="flex flex-wrap gap-2">
              {(["bug", "improvement"] as const).map((category) => (
                <label
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 text-sm has-checked:border-border-focus has-checked:bg-bg-secondary"
                  key={category}
                >
                  <input
                    className="size-4 accent-primary"
                    defaultChecked={category === "bug"}
                    name="category"
                    type="radio"
                    value={category}
                  />
                  {copy[category]}
                </label>
              ))}
            </div>
            <label className="mt-4 block text-sm font-medium" htmlFor={field}>
              {copy.description}
            </label>
            <p className="mt-1 mb-2 text-sm text-foreground-secondary" id={hint}>
              {copy.hint}
            </p>
            <textarea
              aria-describedby={hint}
              className="block w-full resize-y rounded-xl border border-border bg-bg-secondary px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-border-focus"
              id={field}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
              required
              rows={4}
              value={description}
            />
          </fieldset>
          {(status === "error" || status === "limited") && (
            <p className="mt-3 text-sm text-danger-text" role="alert">
              {copy[status]}
            </p>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              className="btn btn-secondary min-h-11"
              disabled={sending}
              onClick={() => dialog.current?.close()}
              type="button"
            >
              {copy.cancel}
            </button>
            <button
              className="btn btn-primary min-h-11"
              disabled={sending || description.trim() === ""}
              type="submit"
            >
              {sending ? copy.sending : copy.send}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
