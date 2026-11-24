import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PassKeeper } from "./bootstrap";

import { CHAT_HISTORY_LENGTH, type ChatMessage, MAX_CHAT_LENGTH } from "../../src/chat";
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
      try {
        const response = await request({ signal });
        if (!response.ok) throw new Error(`Chat history: ${response.status}`);
        const history = (await response.json()) as ChatMessage[];
        if (signal?.aborted) return;
        const previous = historyThrough.current;
        if (previous !== null) {
          const missed = history.findLast((message) => message.id > previous && message.sub !== id);
          if (missed !== undefined) setLatestIncoming((current) => Math.max(current, missed.id));
        }
        historyThrough.current = Math.max(previous ?? 0, history.at(-1)?.id ?? 0);
        add(history);
        setLoad("ready");
      } catch {
        if (!signal?.aborted) setLoad("failed");
      }
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

export function ChatSheet({ chat, shown }: { chat: ReturnType<typeof useChat>; shown: boolean }) {
  const { copy, locale, person } = useBoardUi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: "short" }), [locale]);

  useLayoutEffect(() => {
    if (!shown) follow.current = true;
    if (follow.current && log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [chat.messages, shown]);

  const send = async (message: string) => {
    input.current?.focus();
    setBusy(true);
    setRefusal(null);
    try {
      const result = await chat.send(message);
      setRefusal(result);
      if (result === null) {
        setText((current) => (current.trim() === message ? "" : current));
        follow.current = true;
        if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
      }
    } finally {
      setBusy(false);
    }
  };

  if (!shown) return null;

  return (
    <Sheet panel="chat" title={copy.chat}>
      <div
        aria-label={copy.chat}
        className="max-h-[min(36dvh,16rem)] space-y-3 overflow-y-auto overscroll-contain py-2"
        onScroll={({ currentTarget }) => {
          follow.current =
            currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight < 32;
        }}
        ref={log}
        role="log"
      >
        {chat.messages.map(({ at, id, name, sub, text }) => (
          <article className="space-y-0.5" key={id}>
            <header className="flex items-baseline gap-2">
              <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
              {sub === person.id && (
                <span className="text-xs text-foreground-muted">({copy.you})</span>
              )}
              <time
                className="ml-auto shrink-0 text-xs text-foreground-muted"
                dateTime={new Date(at).toISOString()}
              >
                {time.format(at)}
              </time>
            </header>
            <p className="text-sm wrap-anywhere whitespace-pre-wrap" dir="auto">
              {text}
            </p>
          </article>
        ))}
        {chat.messages.length === 0 && chat.load !== "failed" && (
          <p className="text-sm text-foreground-muted">
            {chat.load === "loading" ? copy.chatLoading : copy.chatEmpty}
          </p>
        )}
      </div>
      {chat.load === "failed" && (
        <div className="mt-2 flex items-baseline gap-2 text-sm text-foreground-muted">
          <p role="status">{copy.chatLoadFailed}</p>
          <button className="underline" onClick={() => void chat.refresh()} type="button">
            {copy.retry}
          </button>
        </div>
      )}
      <form
        className="mt-3 flex gap-2"
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
          className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-bg-secondary px-3 text-base focus:border-primary focus:outline-none"
          enterKeyHint="send"
          maxLength={MAX_CHAT_LENGTH}
          onChange={(event) => setText(event.target.value)}
          placeholder={copy.chatMessage}
          ref={input}
          value={text}
        />
        <button
          className="btn btn-primary min-h-11 shrink-0"
          disabled={busy || text.trim() === ""}
          type="submit"
        >
          {copy.chatSend}
        </button>
      </form>
      {refusal !== null && (
        <p className="mt-2 text-sm text-danger-text" role="status">
          {refusal === "too-fast" ? copy.chatTooFast : copy.chatFailed}
        </p>
      )}
    </Sheet>
  );
}
