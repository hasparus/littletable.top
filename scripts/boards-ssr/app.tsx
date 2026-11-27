import type { ComponentProps } from "react";

import { Front } from "../../client/src/front";
import { FRONT_COPY } from "../../client/src/front-copy";

type Page = ComponentProps<typeof Front>["initialPage"];

export function App({ page }: { page?: Page }) {
  return <Front copy={FRONT_COPY.en} initialPage={page} locale="en" name="Little Table" />;
}
