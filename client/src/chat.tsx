import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PassKeeper } from "./bootstrap";

import { CHAT_HISTORY_LENGTH, type ChatMessage, MAX_CHAT_LENGTH } from "../../src/chat";
import { Avatar } from "./avatar";
import { colorFor } from "./colors";
import { Icon } from "./icons";
import { Sheet } from "./sheet";
import { useBoardUi } from "./ui";

type Refusal = "failed" | "too-fast";

const isChatMessage = (event: unknown): event is { message: ChatMessage; type: "chat" } =>
  typeof event === "object" &&
  event !== null &&
  (event as { type?: unknown }).type === "chat" &&
  typeof (event as { message?: { id?: unknown } }).message?.id === "number";

export function useChat(keeper: PassKeeper, enabled: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [load, setLoad] = useState<"failed" | "loading" | "ready">("loading");
  const [latestIncoming, setLatestIncoming] = useState(0);
  const historyThrough = useRef<number | null>(null);
  const { id } = keeper.bootstrap.person;

  const add = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) byId.set(message.id, message);
      return [...byId.values()].toSorted((a, b) => a.id - b.id).slice(-CHAT_HISTORY_LENGTH);
    });
  }, []);

  const request = useCallback(
    async (init?: RequestInit) =>
      fetch(`${keeper.room}/chat`, {
        ...init,
        headers: { Authorization: `Bearer ${await keeper.pass()}`, ...init?.headers },
      }),
    [keeper],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled) return;
      const response = await request({ signal }).catch(() => null);
      const history = response?.ok
        ? ((await response.json().catch(() => null)) as ChatMessage[] | null)
        : null;
      if (signal?.aborted) return;
      if (history === null) {
        setLoad("failed");
        return;
      }
      const previous = historyThrough.current;
      if (previous !== null) {
        const missed = history.findLast((message) => message.id > previous && message.sub !== id);
        if (missed !== undefined) setLatestIncoming((current) => Math.max(current, missed.id));
      }
      historyThrough.current = Math.max(previous ?? 0, history.at(-1)?.id ?? 0);
      add(history);
      setLoad("ready");
    },
    [add, enabled, id, request],
  );

  const send = useCallback(
    async (text: string): Promise<Refusal | null> => {
      try {
        const response = await request({ body: text, method: "POST" });
        if (response.status === 429) return "too-fast";
        if (!response.ok) return "failed";
        add([(await response.json()) as ChatMessage]);
        return null;
      } catch {
        return "failed";
      }
    },
    [add, request],
  );

  const receive = useCallback(
    (event: unknown) => {
      if (!enabled || !isChatMessage(event)) return;
      const { message } = event;
      add([message]);
      if (message.sub !== id) setLatestIncoming((previous) => Math.max(previous, message.id));
    },
    [add, enabled, id],
  );

  return { latestIncoming, load, messages, receive, refresh, send };
}

const MESSAGE_GROUP_GAP = 5 * 60 * 1000;

function sameRun(previous: ChatMessage | undefined, next: ChatMessage | undefined) {
  return (
    previous !== undefined &&
    next !== undefined &&
    previous.sub === next.sub &&
    previous.name === next.name &&
    next.at - previous.at < MESSAGE_GROUP_GAP
  );
}

export function ChatSheet({ chat, shown }: { chat: ReturnType<typeof useChat>; shown: boolean }) {
  const { copy, locale, person } = useBoardUi();
  const [text, setText] = useState("");
  const [submission, setSubmission] = useState<"idle" | "sending" | Refusal>("idle");
  const busy = submission === "sending";
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: "short" }), [locale]);

  useLayoutEffect(() => {
    if (!shown) follow.current = true;
    if (follow.current && log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [chat.messages, shown]);

  useLayoutEffect(() => {
    const viewport = log.current;
    if (!shown || viewport === null) return;

    // The on-screen keyboard can shrink the log without adding a message.
    const resize = new ResizeObserver(() => {
      if (follow.current) viewport.scrollTop = viewport.scrollHeight;
    });
    resize.observe(viewport);
    return () => resize.disconnect();
  }, [shown]);

  const send = async (message: string) => {
    input.current?.focus();
    setSubmission("sending");
    const result = await chat.send(message);
    setSubmission(result ?? "idle");
    if (result === null) {
      setText((current) => (current.trim() === message ? "" : current));
      follow.current = true;
      if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
    }
  };

  if (!shown) return null;

  return (
    <Sheet panel="chat" title={copy.chat}>
      <div
        aria-label={copy.chat}
        className="min-h-0 max-h-[min(52dvh,23rem)] overflow-y-auto overscroll-contain px-4 py-3 [scrollbar-width:thin] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus"
        onScroll={({ currentTarget }) => {
          follow.current =
            currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
        }}
        ref={log}
        role="log"
        tabIndex={0}
      >
        {chat.messages.map((message, index, messages) => {
          const { at, id, name, sub, text } = message;
          const own = sub === person.id;
          const first = !sameRun(messages[index - 1], message);
          const last = !sameRun(message, messages[index + 1]);
          const author = own ? `${name} (${copy.you})` : name;
          const timestamp = time.format(at);

          return (
            <article
              className={`flex items-end gap-2 ${own ? "justify-end" : ""} ${first ? "not-first:mt-3" : "mt-0.5"}`}
              key={id}
            >
              {!own &&
                (last ? (
                  <Avatar color={colorFor(sub)} name={name} src={null} />
                ) : (
                  <span aria-hidden="true" className="w-8 shrink-0" />
                ))}
              <div
                className={`flex max-w-[82%] min-w-0 flex-col ${own ? "items-end" : "items-start"}`}
              >
                <header
                  className={
                    first
                      ? "mb-1 flex max-w-full items-baseline gap-2 px-3 text-xs text-foreground-muted"
                      : "sr-only"
                  }
                >
                  <span className={own ? "sr-only" : "min-w-0 truncate"} dir="auto" title={author}>
                    {author}
                  </span>
                  <time className="shrink-0 tabular-nums" dateTime={new Date(at).toISOString()}>
                    {timestamp}
                  </time>
                </header>
                <p
                  className={`max-w-full rounded-[1.125rem] px-3.5 py-2 text-[0.9375rem] leading-snug wrap-anywhere whitespace-pre-wrap ${own ? "bg-(--brand-primary-strong) text-white" : "bg-bg-tertiary text-foreground"} ${!first && (own ? "rounded-se-md" : "rounded-ss-md")} ${!last && (own ? "rounded-ee-md" : "rounded-es-md")}`}
                  title={timestamp}
                >
                  <span className="block" dir="auto">
                    {text}
                  </span>
                </p>
              </div>
            </article>
          );
        })}
        {chat.messages.length === 0 && chat.load !== "failed" && (
          <p className="text-sm text-foreground-muted">
            {chat.load === "loading" ? copy.chatLoading : copy.chatEmpty}
          </p>
        )}
      </div>
      {chat.load === "failed" && (
        <div className="flex shrink-0 items-baseline gap-2 px-4 pb-2 text-sm text-foreground-muted">
          <p role="status">{copy.chatLoadFailed}</p>
          <button className="underline" onClick={() => void chat.refresh()} type="button">
            {copy.retry}
          </button>
        </div>
      )}
      <form
        className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          const message = text.trim();
          if (busy || message === "") return;
          void send(message);
        }}
      >
        <input
          aria-label={copy.chatMessage}
          autoComplete="off"
          className="h-11 min-w-0 flex-1 rounded-full border border-border bg-bg-tertiary px-4 text-base placeholder:text-foreground-muted focus-visible:outline-2 focus-visible:outline-border-focus"
          dir="auto"
          enterKeyHint="send"
          maxLength={MAX_CHAT_LENGTH}
          onChange={(event) => setText(event.target.value)}
          placeholder={copy.chatMessage}
          ref={input}
          value={text}
        />
        <button
          aria-label={copy.chatSend}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-(--brand-primary-strong) text-white hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus disabled:bg-bg-tertiary disabled:text-foreground-muted disabled:brightness-100"
          disabled={busy || text.trim() === ""}
          title={copy.chatSend}
          type="submit"
        >
          <Icon name="Send" />
        </button>
      </form>
      {(submission === "failed" || submission === "too-fast") && (
        <p className="shrink-0 px-4 pb-3 text-sm text-danger-text" role="status">
          {submission === "too-fast" ? copy.chatTooFast : copy.chatFailed}
        </p>
      )}
    </Sheet>
  );
}
