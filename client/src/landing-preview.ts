import type { Editor } from "tldraw";

import type { LandingCopy } from "./front-copy";

export function landingPreview(copy: LandingCopy) {
  const note = document.createElement("section");
  note.dataset.landingPreview = "";
  note.setAttribute("aria-label", copy.publicBoard);
  for (const paragraph of copy.publicStory) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    note.append(p);
  }
  const footer = document.createElement("footer");
  footer.textContent = copy.publicExpiry;
  note.append(footer);
  return note;
}

/** Match the prerender before handing the fixed layout over to the canvas camera. */
export function fitPublicBoardIntro(editor: Editor) {
  const preview = document.querySelector<HTMLElement>("[data-landing-preview]");
  if (!preview) return;
  const { x, y, width } = preview.getBoundingClientRect();
  const style = getComputedStyle(preview);
  const viewport = editor.getViewportScreenBounds();
  const zoom = width / Number(style.getPropertyValue("--landing-width"));
  editor.setCamera({
    x: (x - viewport.x) / zoom - Number(style.getPropertyValue("--landing-left")),
    y: (y - viewport.y) / zoom - Number(style.getPropertyValue("--landing-top")),
    z: zoom,
  });
}
