import type { LandingCopy } from "./front-copy";

import { landingPreview } from "./landing-preview";

export function LandingPlaceholder({ copy }: { copy: LandingCopy }) {
  return (
    <div
      ref={(node) => {
        if (node) node.replaceChildren(landingPreview(copy));
      }}
    />
  );
}
