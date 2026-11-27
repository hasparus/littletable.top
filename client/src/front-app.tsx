import type { Language } from "../settings";
import type { FrontCopy } from "./front-copy";
import type { FrontPage } from "./front-page";

import { FeedbackProvider } from "./feedback";
import { Front } from "./front";
import { Assistants } from "./front-assistants";

/** What the Worker renders and serializes for hydration on `/boards` and `/assistants`. */
export type FrontState = { locale: Language; name: string; page: FrontPage };

export function FrontApp({ copy, locale, name, page }: FrontState & { copy: FrontCopy }) {
  return (
    <FeedbackProvider enabled language={locale}>
      {page.view === "boards" ? (
        <Front
          copy={copy}
          failed={page.failed}
          initialPage={page.initialPage}
          locale={locale}
          name={name}
        />
      ) : (
        <Assistants copy={copy} initialPage={page.initialPage} name={name} />
      )}
    </FeedbackProvider>
  );
}
