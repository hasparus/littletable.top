import { react, type Editor } from "tldraw";

export function carryTool(from: Editor, to: Editor) {
  const tool = from.getCurrentToolId();
  const state = from.getInstanceState();
  from.complete();
  from.blur();
  to.updateInstanceState({
    isToolLocked: state.isToolLocked,
    opacityForNextShape: state.opacityForNextShape,
    stylesForNextShape: state.stylesForNextShape,
  });
  to.setCurrentTool(tool);
}

export function openOverlay(shared: Editor, secret: Editor) {
  const page = shared.getCurrentPage();
  if (!secret.getPage(page.id)) {
    if (secret.getPages().length >= secret.options.maxPages) return false;
    secret.createPage({ id: page.id, name: page.name });
  }
  if (secret.getCurrentPageId() !== page.id) secret.setCurrentPage(page.id);
  secret.setCamera(shared.getCamera(), { immediate: true });
  carryTool(shared, secret);
  return true;
}

export function alignLayers(shared: Editor, secret: Editor) {
  const container = shared.getContainer();
  const stop = react("align shared canvas", () => {
    const page = secret.getCurrentPageId();
    const visible = shared.getPage(page) !== undefined;
    container.style.visibility = visible ? "" : "hidden";
    if (!visible) return;
    if (page !== shared.getCurrentPageId()) {
      shared.run(() => shared.setCurrentPage(page), { history: "ignore" });
    }
    shared.setCamera(secret.getCamera(), { immediate: true });
  });
  return () => {
    stop();
    container.style.visibility = "";
  };
}
