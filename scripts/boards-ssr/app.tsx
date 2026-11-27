import type { ComponentProps } from "react";

import { FeedbackProvider } from "../../client/src/feedback";
import { Front } from "../../client/src/front";
import { FRONT_COPY } from "../../client/src/front-copy";

type Page = ComponentProps<typeof Front>["initialPage"];

export function App({ page }: { page: Page }) {
  return (
    <FeedbackProvider enabled language="en">
      <Front copy={FRONT_COPY.en} initialPage={page} locale="en" name="Little Table" />
    </FeedbackProvider>
  );
}
