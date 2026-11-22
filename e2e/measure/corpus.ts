// The labels the text-measurement harness asks the real tldraw editor
// about. Each kind of text stresses a different part of a measurer: plain
// Latin (advances and kerning), Polish diacritics (glyphs outside ASCII),
// long words (overflow-wrap), explicit lines, CJK and emoji (glyphs no
// tldraw font has, drawn from the system's fallback fonts).

export type Family = "draw" | "mono" | "sans" | "serif";
export type Size = "l" | "m" | "s" | "xl";

export type Label = { kind: string; text: string };

export const LABELS: Label[] = [
  { kind: "latin", text: "Tavern" },
  { kind: "latin", text: "The quick brown fox jumps over the lazy dog" },
  { kind: "latin", text: "AVATAR WAVE Tyrant" },
  { kind: "latin", text: "Initiative: Bea, Cyprian, Ola" },
  { kind: "latin", text: "Hit points 27/31 (-4)" },
  {
    kind: "latin",
    text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod",
  },
  { kind: "polish", text: "Zażółć gęślą jaźń" },
  { kind: "polish", text: "Mapa lochów — poziom 2" },
  { kind: "polish", text: "Przygoda w Górach Sowich i Łysej Polanie" },
  { kind: "polish", text: "Źródło, ćma, ŚWIĘTOKRZYSKIE, żółw" },
  { kind: "long-word", text: "supercalifragilisticexpialidocious" },
  { kind: "long-word", text: "Konstantynopolitańczykowianeczka" },
  { kind: "long-word", text: "see https://example.org/a/very/long/path/to/a/handout" },
  { kind: "multi-line", text: "Session 3\nThe crypt\nBring torches" },
  { kind: "multi-line", text: "One\n\nThree after a blank line" },
  { kind: "hyphen", text: "well-known state-of-the-art half-orc" },
  { kind: "cjk", text: "地下城与勇士" },
  { kind: "cjk", text: "ダンジョン探索 Dungeon" },
  { kind: "emoji", text: "Loot 💰🗡️🛡️" },
  { kind: "emoji", text: "🐉 Dragon lair 🔥" },
];

export const FAMILIES: Family[] = ["draw", "sans", "serif", "mono"];
export const SIZES: Size[] = ["s", "m", "l", "xl"];

// Rich text with bold runs, as tldraw's editor writes it.
export const BOLD_LABELS: { kind: string; parts: { bold: boolean; text: string }[] }[] = [
  {
    kind: "bold",
    parts: [
      { bold: true, text: "Boss:" },
      { bold: false, text: " the Lich King" },
    ],
  },
  {
    kind: "bold",
    parts: [
      { bold: false, text: "Roll " },
      { bold: true, text: "Perception" },
      { bold: false, text: " before entering the vault" },
    ],
  },
  { kind: "bold", parts: [{ bold: true, text: "Zażółć gęślą jaźń" }] },
];
