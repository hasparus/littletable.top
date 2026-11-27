import { type ReactNode, useState } from "react";

import { thumbnailUrl } from "../../src/board-thumbnail";
import { Icon } from "./icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";

export const LIST = "divide-y divide-border border-t border-border";

const ROW =
  "relative grid min-h-15 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2 @3xl:grid-cols-[auto_minmax(0,1fr)_minmax(9rem,22%)_minmax(9rem,max-content)] @3xl:gap-x-4";
const ACTION_BESIDE =
  "relative col-start-3 row-span-2 row-start-1 flex items-center justify-self-end @3xl:col-start-4 @3xl:row-span-1";
const ACTION_BELOW =
  "relative col-span-2 col-start-2 row-start-3 mt-2 flex justify-self-start @md:col-span-1 @md:col-start-3 @md:row-span-2 @md:row-start-1 @md:mt-0 @md:justify-self-end @3xl:col-start-4 @3xl:row-span-1";

/**
 * One board in a list: its thumbnail, title, a detail line and an action.
 * A wide action goes `below` the title until the list is wide enough to hold it beside.
 */
export function BoardRow({
  action,
  actionPlacement = "beside",
  board,
  detail,
  title,
}: {
  action?: ReactNode;
  actionPlacement?: "beside" | "below";
  board: { id: string; thumbnail: boolean };
  detail: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className={ROW}>
      <span
        aria-hidden="true"
        className="col-start-1 row-span-2 row-start-1 aspect-video w-18 overflow-hidden rounded-md border border-border bg-bg-secondary sm:w-24 @3xl:row-span-1 @3xl:w-28"
      >
        {board.thumbnail && (
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
      <div className="col-start-2 row-start-1 min-w-0 self-end font-semibold wrap-anywhere @3xl:self-center">
        {title}
      </div>
      <div className="col-start-2 row-start-2 self-start text-sm text-foreground-muted tabular-nums @3xl:col-start-3 @3xl:row-start-1 @3xl:self-center">
        {detail}
      </div>
      {action !== undefined && (
        <div className={actionPlacement === "below" ? ACTION_BELOW : ACTION_BESIDE}>{action}</div>
      )}
    </div>
  );
}

export function EmptyList({ children }: { children: ReactNode }) {
  return <p className="border-t border-border py-4 text-foreground-muted">{children}</p>;
}

export function BoardCollection({
  children,
  className = "",
  collapsible,
  description,
  label,
  showHeading = true,
}: {
  children: ReactNode;
  className?: string;
  collapsible: boolean;
  description?: string;
  label: string;
  showHeading?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const open = !collapsible || expanded;
  let heading = <h2 className={showHeading ? "font-semibold" : "sr-only"}>{label}</h2>;
  if (collapsible) {
    heading = (
      <h2 className="font-semibold">
        <CollapsibleTrigger className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-border-focus">
          {label}
          <Icon
            className="size-4 shrink-0 motion-safe:transition-transform group-data-[state=open]:rotate-180"
            name="ChevronDown"
          />
        </CollapsibleTrigger>
      </h2>
    );
  }
  return (
    <Collapsible asChild onOpenChange={setExpanded} open={open}>
      <section className={`@container min-w-0 ${className}`}>
        {heading}
        {description !== undefined && (
          <p className="text-sm wrap-anywhere text-foreground-muted">{description}</p>
        )}
        <CollapsibleContent
          className={
            collapsible
              ? "motion-safe:data-[state=closed]:animate-collapsible-up motion-safe:data-[state=open]:animate-collapsible-down"
              : showHeading
                ? "mt-2"
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
