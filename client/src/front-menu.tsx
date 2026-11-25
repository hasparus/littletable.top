import { type ReactNode, useEffect, useRef, useState } from "react";

export const MENU_BUTTON =
  "flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus";

export function FrontMenu({
  children,
  label,
  trigger,
}: {
  children: ReactNode;
  label: string;
  trigger: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const menu = details.current;
    if (menu === null) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return (
    <details
      className="relative"
      name="board-list-menu"
      onBlur={({ currentTarget, relatedTarget }) => {
        if (relatedTarget !== null && !currentTarget.contains(relatedTarget)) {
          currentTarget.open = false;
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      ref={details}
    >
      <summary
        aria-label={label}
        className="grid size-11 cursor-pointer list-none place-items-center rounded-lg hover:bg-bg-secondary focus-visible:outline-2 focus-visible:outline-border-focus [&::-webkit-details-marker]:hidden"
        title={label}
      >
        {trigger}
      </summary>
      <div className="absolute top-full right-0 z-10 w-max min-w-36 max-w-60 rounded-xl border border-border bg-bg-secondary p-1">
        {children}
      </div>
    </details>
  );
}
