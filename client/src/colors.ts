// The colour a person has on a board, on their cursor and around their
// avatar. Apart from tldraw, so the front page can use it without loading it.

// tldraw's cursor colours, picked by person so a colour stays with them.
const COLORS = [
  "#ff802b",
  "#ec5e41",
  "#f2555a",
  "#f04f88",
  "#e34ba9",
  "#bd54c6",
  "#9d5bd2",
  "#7b66dc",
  "#02b1cc",
  "#11b3a3",
  "#39b178",
  "#55b467",
];

export function colorFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) % 2_147_483_647;
  return COLORS[hash % COLORS.length]!;
}
