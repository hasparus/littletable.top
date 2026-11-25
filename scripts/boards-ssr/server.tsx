import type { ComponentProps } from "react";

import { renderToString } from "react-dom/server";

import { App } from "./app";
export { boardShell } from "../../client/src/front-skeleton";

export function render(page: ComponentProps<typeof App>["page"]) {
  return renderToString(<App page={page} />);
}
