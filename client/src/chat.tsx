import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PassKeeper } from "./bootstrap";
import type { ChatSize } from "./chat-resize";

import { CHAT_HISTORY_LENGTH, type ChatMessage, MAX_CHAT_LENGTH } from "../../src/chat";
import { EXPRESSION_ERRORS, type ExpressionError } from "../../src/dice-expression";
import { Avatar } from "./avatar";
import { colorFor } from "./colors";
import { notationMessage } from "./dice-labels";
import { Icon } from "./icons";
import { Sheet } from "./sheet";
import { PANEL_ID, useBoardUi } from "./ui";

type Refusal = "failed" | "too-fast" | ExpressionError;

const isChatMessage = (event: unknown): event is { message: ChatMessage; type: "chat" } =>
  typeof event === "object" &&
  event !== null &&
  (event as { type?: unknown }).type === "chat" &&
  typeof (event as { message?: { id?: unknown } }).message?.id === "number";

export function useChat(keeper: PassKeeper) {
  const enabled = !keeper.secret;
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
        if (response.status === 400) {
          const body: { error?: unknown } | null = await response.json().catch(() => null);
          return EXPRESSION_ERRORS.find((error) => error === body?.error) ?? "failed";
        }
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

export function ChatButton({ unread }: { unread: boolean }) {
  const { copy, open, panel } = useBoardUi();
  const shown = panel === "chat";
  return (
    <button
      aria-controls={shown ? PANEL_ID.chat : undefined}
      aria-expanded={shown}
      aria-label={copy.chat}
      className="relative place-items-center"
      data-board-chat
      onClick={() => open(shown ? null : "chat")}
      title={copy.chat}
      type="button"
    >
      <Icon name="Chat" />
      {!shown && unread && (
        <span
          aria-hidden="true"
          className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary"
        />
      )}
    </button>
  );
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
  const [size, setSize] = useState<ChatSize>({});
  const [submission, setSubmission] = useState<"idle" | "sending" | Refusal>("idle");
  const busy = submission === "sending";
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const logSize = useRef({ height: 0, width: 0 });
  const resizeAnchor = useRef<{ element: Element; offset: number } | null>(null);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: "short" }), [locale]);

  useLayoutEffect(() => {
    if (!shown) follow.current = true;
    if (follow.current && log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [chat.messages, shown]);

  useLayoutEffect(() => {
    const viewport = log.current;
    if (!shown || viewport === null) return;

    // WARNING: Follow keyboard-driven log resizes even when no message arrives.
    const measure = () => {
      logSize.current = { height: viewport.clientHeight, width: viewport.clientWidth };
      if (follow.current) viewport.scrollTop = viewport.scrollHeight;
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    return () => resize.disconnect();
  }, [shown]);

  useLayoutEffect(() => {
    const viewport = log.current;
    const anchor = resizeAnchor.current;
    resizeAnchor.current = null;
    if (viewport === null || anchor === null || !viewport.contains(anchor.element)) return;
    viewport.scrollTop +=
      anchor.element.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      anchor.offset;
  }, [size.width]);

  const resize = (next: ChatSize) => {
    const viewport = log.current;
    if (!follow.current && viewport !== null && next.width !== size.width) {
      // WARNING: Keep the same message in view when the new width rewraps the thread.
      const { top } = viewport.getBoundingClientRect();
      const element = [...viewport.children].find(
        (child) => child.getBoundingClientRect().bottom > top,
      );
      if (element !== undefined) {
        resizeAnchor.current = { element, offset: element.getBoundingClientRect().top - top };
      }
    }
    setSize(next);
  };

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
  const error =
    submission === "idle" || submission === "sending"
      ? null
      : submission === "failed"
        ? copy.chatFailed
        : submission === "too-fast"
          ? copy.chatTooFast
          : notationMessage(copy, submission);

  return (
    <Sheet chatResize={{ change: resize, size }} panel="chat" title={copy.chat}>
      <div
        aria-label={copy.chat}
        className={`min-h-0 overflow-y-auto overscroll-contain px-4 py-3 mask-[linear-gradient(to_top,transparent,black_8px)] [scrollbar-width:thin] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus ${size.height === undefined ? "max-h-[min(52dvh,23rem)]" : "flex-1"}`}
        onScroll={({ currentTarget }) => {
          // WARNING: Chrome can deliver scroll clamping before the observer sees the new size.
          if (
            currentTarget.clientHeight !== logSize.current.height ||
            currentTarget.clientWidth !== logSize.current.width
          )
            return;
          follow.current =
            currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
        }}
        ref={log}
        role="log"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The scrollable log needs keyboard focus for keyboard scrolling.
        tabIndex={0}
      >
        {chat.messages.map((message, index, messages) => {
          const { at, diceTotal, id, name, sub, text } = message;
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
                    {diceTotal === undefined ? (
                      text
                    ) : (
                      <>
                        <code className="text-[0.875em]">{text}</code>
                        <span aria-hidden="true"> = </span>
                        <span className="sr-only"> {copy.total} </span>
                        <strong className="tabular-nums">{diceTotal}</strong>
                      </>
                    )}
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
      {error !== null && (
        <p className="shrink-0 px-4 pb-2 text-sm text-danger-text" role="status">
          {error}
        </p>
      )}
      <form
        className="shrink-0 p-(--chat-padding)"
        onSubmit={(event) => {
          event.preventDefault();
          const message = text.trim();
          if (busy || message === "") return;
          void send(message);
        }}
      >
        <div className="flex h-11 rounded-(--chat-composer-radius) border border-border bg-bg-tertiary has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-border-focus">
          <input
            aria-label={copy.chatMessage}
            autoCapitalize="none"
            autoComplete="off"
            className="min-w-0 flex-1 px-3 text-base outline-none placeholder:text-foreground-muted"
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
            className="grid w-11 shrink-0 place-items-center rounded-[inherit] text-primary-strong enabled:hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus disabled:text-foreground-muted"
            disabled={busy || text.trim() === ""}
            title={copy.chatSend}
            type="submit"
          >
            <Icon name="Send" />
          </button>
        </div>
      </form>
    </Sheet>
  );
}
