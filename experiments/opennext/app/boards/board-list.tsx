"use client";

import type { ComponentProps } from "react";

import { useEffect } from "react";

import { BoardsApp } from "../../../../client/src/front";
import { FRONT_COPY } from "../../../../client/src/front-copy";

export type BoardListProps = Omit<ComponentProps<typeof BoardsApp>, "copy">;

export function BoardList(props: BoardListProps) {
  useEffect(() => {
    document.documentElement.lang = props.locale;
    document.documentElement.classList.toggle(
      "dark",
      matchMedia("(prefers-color-scheme: dark)").matches,
    );
  }, [props.locale]);

  return (
    <div data-board-root className="fixed inset-0 overflow-y-auto bg-background">
      <BoardsApp {...props} copy={FRONT_COPY[props.locale]} />
    </div>
  );
}
