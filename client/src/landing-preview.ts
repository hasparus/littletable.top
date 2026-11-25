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
