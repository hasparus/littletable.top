import type { Editor } from "tldraw";

import { PUBLIC_HANDOUT } from "../../src/public-board-demo-ids";

export function publicDemoPage(editor: Editor) {
  const page = editor.getAncestorPageId(PUBLIC_HANDOUT);
  return page !== undefined && editor.getPage(page) !== undefined ? page : undefined;
}
