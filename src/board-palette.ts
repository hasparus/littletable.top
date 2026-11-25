export const PALETTE = {
  default: {
    dark: "var(--tl-color-background)",
    label: "boardBackgroundDefault",
    light: "var(--tl-color-background)",
  },
  lilac: { dark: "#33283d", label: "boardBackgroundLilac", light: "#f0e9f7" },
  sage: { dark: "#2c2f2a", label: "boardBackgroundSage", light: "#ebede7" },
  sand: { dark: "#342c20", label: "boardBackgroundSand", light: "#f6eedc" },
  sky: { dark: "#222d3d", label: "boardBackgroundSky", light: "#e6eff9" },
} as const;

export type BoardColor = keyof typeof PALETTE;

export function isBoardColor(color: unknown): color is BoardColor {
  return typeof color === "string" && Object.hasOwn(PALETTE, color);
}
