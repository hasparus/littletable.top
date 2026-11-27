import { type ReactNode, useState } from "react";

import { thumbnailUrl } from "../../src/board-thumbnail";
import { Icon } from "./icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export const LIST = "divide-y divide-border border-t border-border";
export const BOARD_TITLE =
  "col-start-2 row-start-1 min-w-0 self-end font-semibold @3xl:self-center";
export const BOARD_DETAIL =
  "col-start-2 row-start-2 self-start text-sm text-foreground-muted tabular-nums @3xl:col-start-3 @3xl:row-start-1 @3xl:self-center";

export function BoardThumbnail({
  board,
}: {
  board: { hasThumbnail?: boolean; id: string; shareCode: string | null };
}) {
  return (
    <span
      aria-hidden="true"
      className="col-start-1 row-span-2 row-start-1 aspect-video w-18 overflow-hidden rounded-md border border-border bg-bg-secondary sm:w-24 @3xl:row-span-1 @3xl:w-28"
    >
      {board.hasThumbnail === true && board.shareCode !== null && (
        <img
          alt=""
          className="size-full bg-(--light-board-background) object-cover"
          decoding="async"
          loading="lazy"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
          src={thumbnailUrl(board.id)}
        />
      )}
    </span>
  );
}

export function EmptyList({ children }: { children: ReactNode }) {
  return <p className="border-t border-border py-4 text-foreground-muted">{children}</p>;
}

export function BoardCollection({
  children,
  className = "",
  collapsible,
  label,
  showHeading = true,
}: {
  children: ReactNode;
  className?: string;
  collapsible: boolean;
  label: string;
  showHeading?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const open = !collapsible || expanded;
  return (
    <Collapsible asChild onOpenChange={setExpanded} open={open}>
      <section className={`@container min-w-0 ${className}`}>
        {collapsible ? (
          <h2 className="font-semibold">
            <CollapsibleTrigger className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-border-focus">
              {label}
              <Icon
                className="size-4 shrink-0 motion-safe:transition-transform group-data-[state=open]:rotate-180"
                name="ChevronDown"
              />
            </CollapsibleTrigger>
          </h2>
        ) : (
          <h2 className={showHeading ? "mb-2 font-semibold" : "sr-only"}>{label}</h2>
        )}
        <CollapsibleContent
          className={
            collapsible
              ? "motion-safe:data-[state=closed]:animate-collapsible-up motion-safe:data-[state=open]:animate-collapsible-down"
              : undefined
          }
          inert={!open}
        >
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
