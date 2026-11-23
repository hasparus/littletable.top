// How well a reading of a fixture image serves the board's search, against
// the fixture's ground truth (e2e/fixtures/text/*.gt.json, written by
// generate.py). Used by the filter's unit test (test/text-filter.test.ts)
// and the engines' accuracy test (e2e/tests/text-accuracy.spec.ts).
//
// - names found: of the words a person would search for (`searchable`),
//   the share some read word matches folded within the search's own typo
//   allowance (one edit up to five letters, two from six), alone or joined
//   with the next word (engines drop and add spaces);
// - junk: read words with a letter or digit that match no word of the
//   image within that allowance: what a search would turn up for nothing;
// - located: the share of the image's words that a read word with the
//   same text covers with IoU ≥ 0.5;
// - diacritics: the share of Polish letters with diacritics in the
//   image's words that survive in the words read over them.

export type TruthWord = { angle: number; bbox: number[]; curved: boolean; text: string };
export type Truth = {
  category: string;
  height: number;
  image: string;
  searchable: string[];
  width: number;
  words: TruthWord[];
};
export type ScoredWord = { box: number[]; text: string };

const PUNCTUATION = /^[.,:;()—\-!?"'„”]+|[.,:;()—\-!?"'„”]+$/gu;
const DIACRITICS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/gu;

const strip = (text: string) => text.replaceAll(PUNCTUATION, "");

export const foldWord = (text: string) =>
  strip(text)
    .replaceAll("ł", "l")
    .replaceAll("Ł", "L")
    .normalize("NFD")
    .replaceAll(/\p{Mn}/gu, "")
    .toLowerCase();

export function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

const allowance = (term: string) => (term.length <= 3 ? 0 : term.length <= 5 ? 1 : 2);

const near = (term: string, read: string) => editDistance(term, read) <= allowance(term);

const size = (box: number[]) => (box[2]! - box[0]!) * (box[3]! - box[1]!);

function iou(a: number[], b: number[]): number {
  const x = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
  const y = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
  const inter = x * y;
  if (inter === 0) return 0;
  return inter / (size(a) + size(b) - inter);
}

function cover(truth: number[], box: number[]): number {
  const x = Math.max(0, Math.min(truth[2]!, box[2]!) - Math.max(truth[0]!, box[0]!));
  const y = Math.max(0, Math.min(truth[3]!, box[3]!) - Math.max(truth[1]!, box[1]!));
  return (x * y) / ((truth[2]! - truth[0]!) * (truth[3]! - truth[1]!));
}

export type Score = {
  diacritics: number | null;
  junk: number;
  located: number;
  names: number;
  namesFound: string[];
  namesMissed: string[];
};

export function score(truth: Truth, read: readonly ScoredWord[]): Score {
  const tokens = read.map((word) => foldWord(word.text)).filter((token) => token.length > 0);
  const joined = tokens.flatMap((token, at) =>
    at + 1 < tokens.length ? [token + tokens[at + 1]] : [],
  );
  const namesFound: string[] = [];
  const namesMissed: string[] = [];
  for (const name of truth.searchable) {
    const term = foldWord(name);
    if ([...tokens, ...joined].some((token) => near(term, token))) namesFound.push(name);
    else namesMissed.push(name);
  }
  const known = truth.words.map((word) => foldWord(word.text)).filter((word) => word.length > 0);
  const junk = tokens.filter(
    (token) =>
      /[\p{L}\p{N}]/u.test(token) && !known.some((word) => near(word, token) || near(token, word)),
  ).length;
  const located = truth.words.filter((word) =>
    read.some(
      (other) =>
        strip(other.text).toLowerCase() === strip(word.text).toLowerCase() &&
        iou(word.bbox, other.box) >= 0.5,
    ),
  ).length;
  let marks = 0;
  let kept = 0;
  for (const word of truth.words) {
    const need = word.text.match(DIACRITICS) ?? [];
    if (need.length === 0) continue;
    const over = read
      .filter((other) => cover(word.bbox, other.box) >= 0.3)
      .map((other) => other.text)
      .join("");
    const have: string[] = over.match(DIACRITICS) ?? [];
    marks += need.length;
    for (const letter of need) {
      const at = have.indexOf(letter);
      if (at === -1) continue;
      kept++;
      have.splice(at, 1);
    }
  }
  return {
    diacritics: marks === 0 ? null : kept / marks,
    junk,
    located: located / truth.words.length,
    names: namesFound.length / Math.max(1, truth.searchable.length),
    namesFound,
    namesMissed,
  };
}
