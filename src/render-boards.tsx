import type { ComponentProps } from "react";

import { renderToString } from "react-dom/server.edge";

import { BoardsApp } from "../client/src/front";
import { FRONT_COPY } from "../client/src/front-copy";

export function renderBoards(props: Omit<ComponentProps<typeof BoardsApp>, "copy">) {
  return renderToString(<BoardsApp {...props} copy={FRONT_COPY[props.locale]} />);
}
