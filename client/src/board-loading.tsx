import { DefaultSpinner } from "tldraw";

function syncSpinnerRotation(spinner: SVGSVGElement | null) {
  for (const animation of spinner?.getAnimations() ?? []) animation.startTime = 0;
}

export function BoardLoading({ text }: { text: string }) {
  return (
    <div
      className="absolute inset-x-0 top-0 grid place-items-center bg-background text-foreground-secondary"
      data-board-loading
      role="status"
    >
      <span className="sr-only">{text}</span>
      <DefaultSpinner
        aria-hidden="true"
        className="motion-reduce:animate-none"
        ref={syncSpinnerRotation}
      />
    </div>
  );
}
