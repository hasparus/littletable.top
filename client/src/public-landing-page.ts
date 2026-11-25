import { type Editor, isPageId } from "tldraw";

import { PUBLIC_SIGNATURE_GROUP } from "../../src/public-signature";

export function signaturePage(editor: Editor) {
  const parent = editor.store.get(PUBLIC_SIGNATURE_GROUP)?.parentId;
  return parent !== undefined && isPageId(parent) ? parent : undefined;
}

export const publicLandingPage = (editor: Editor) =>
  signaturePage(editor) ?? editor.getPages()[0]?.id;
