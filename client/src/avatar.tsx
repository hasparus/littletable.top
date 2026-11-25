import { type CSSProperties, useState } from "react";

const SIZES = { md: "size-9 text-base", sm: "size-8 text-sm" } as const;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function initialOf(name: string): string {
  const [first] = segmenter.segment(name.trim());
  return first === undefined ? "?" : first.segment.toLocaleUpperCase();
}

/**
 * Keep the same size when the picture arrives to avoid layout shifts.
 * The name is rendered beside the avatar, so screen readers only need that label.
 */
export function Avatar({
  color,
  name,
  size = "sm",
  src,
}: {
  color: string;
  name: string;
  size?: keyof typeof SIZES;
  src: string | null;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const style: CSSProperties = {
    backgroundColor: `color-mix(in srgb, ${color} 25%, white)`,
    boxShadow: `0 0 0 2px ${color}`,
  };
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-ink select-none ${SIZES[size]}`}
      style={style}
    >
      {initialOf(name)}
      {src !== null && failed !== src && (
        <img
          alt=""
          className="absolute inset-0 size-full object-cover"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          src={src}
        />
      )}
    </span>
  );
}
