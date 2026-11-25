import { useEffect, useState } from "react";
import { createTLStore, type Editor, react, type TLPage, type TLStore } from "tldraw";

export type SharedView = {
  camera: ReturnType<Editor["getCamera"]>;
  page: Pick<TLPage, "id" | "name">;
  store: TLStore;
};

export function captureSharedView(editor: Editor): SharedView {
  return {
    camera: editor.getCamera(),
    page: editor.getCurrentPage(),
    // WARNING: The shared backdrop takes only document records and must use a store with no sync connection.
    store: createTLStore({
      assets: {
        resolve: editor.store.props.assets.resolve,
        upload: async () => {
          throw new Error("board: the shared backdrop is read-only");
        },
      },
      schema: editor.store.schema,
      snapshot: editor.store.getStoreSnapshot(),
    }),
  };
}

export function useSharedBackdrop(source: Editor | null) {
  const [backdrop, setBackdrop] = useState<Editor | null>(null);
  useEffect(() => {
    if (backdrop === null || source === null) return;
    return react("align shared backdrop", () => {
      const page = source.getCurrentPageId();
      const visible = backdrop.getPage(page) !== undefined;
      backdrop.getContainer().style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;
      if (page !== backdrop.getCurrentPageId()) backdrop.setCurrentPage(page);
      backdrop.setCamera(source.getCamera(), { immediate: true });
    });
  }, [backdrop, source]);
  return setBackdrop;
}
