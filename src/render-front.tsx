import { renderToString } from "react-dom/server.edge";

import { FrontApp, type FrontState } from "../client/src/front-app";
import { FRONT_COPY } from "../client/src/front-copy";

export function renderFront(state: FrontState) {
  return renderToString(<FrontApp {...state} copy={FRONT_COPY[state.locale]} />);
}
