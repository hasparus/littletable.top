import type { ComponentProps } from "react";

import { renderToString } from "react-dom/server.edge";

import { Front } from "../client/src/front";
import { FRONT_COPY } from "../client/src/front-copy";

export function renderBoards(props: Omit<ComponentProps<typeof Front>, "copy">) {
  return renderToString(<Front {...props} copy={FRONT_COPY[props.locale]} />);
}
