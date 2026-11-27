import type { Language } from "../settings";
import type { FrontCopy } from "./front-copy";

import { FeedbackProvider } from "./feedback";
import { type BoardPage, Front } from "./front";
import { Assistants, type AssistantsPage } from "./front-assistants";

/** What the Worker renders and serializes for hydration on `/boards` and `/assistants`. */
export type FrontState = { locale: Language; name: string } & (
  | { failed?: boolean; initialPage?: "signed-out" | BoardPage; view: "boards" }
  | { initialPage?: AssistantsPage; view: "assistants" }
);
export type FrontView = FrontState["view"];

export function FrontApp(props: FrontState & { copy: FrontCopy }) {
  return (
    <FeedbackProvider enabled language={props.locale}>
      {props.view === "boards" ? (
        <Front
          copy={props.copy}
          failed={props.failed}
          initialPage={props.initialPage}
          locale={props.locale}
          name={props.name}
        />
      ) : (
        <Assistants copy={props.copy} initialPage={props.initialPage} name={props.name} />
      )}
    </FeedbackProvider>
  );
}
