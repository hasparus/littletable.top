import type { TLSyncStorageTransaction } from "@tldraw/sync-core";
import type { TLPageId, TLRecord } from "@tldraw/tlschema";

import { "createShapeId" as signatureId } from "@tldraw/tlschema";
import { getIndexAbove, sortByIndex } from "@tldraw/utils";

type Drawing = Extract<TLRecord, { typeName: "shape" }>;
type SignatureGroup = Extract<Drawing, { type: "group" }>;
type SignatureStroke = Extract<Drawing, { type: "draw" }>;

export const PUBLIC_SIGNATURE_GROUP = signatureId("public-landing-signature");

const PEN = {
  color: "black",
  dash: "draw",
  fill: "none",
  isComplete: true,
  isPen: true,
  scale: 1,
  scaleX: 0.9945813806874406,
  scaleY: 0.9549715186883826,
  size: "s",
} as const;

const originalStrokes = [
  {
    id: signatureId("w7-s40Kgte2Lo2E5yFG-D"),
    x: 9.5701,
    y: 21.6519,
    isClosed: true,
    path: "cT2KvnE9ir7NzMw9j7pmuAAAj7pmuAAAj7pSuK4nZrh7tGYqUrhStB8pe7QAAB8tezRSNB8hUjRmOB8lUjSPOgAAZjhcPAAAUjhmPB8hZjhcPAAAjzpxPQAAZjh7PR8hUjh7PR8hZjhcPK6nZjhcPB+hUjiPOh+hZjhcPAAAUjRmOK6njzqPOh+lUjR7tK6vUrR7uh+pUrRmuB+pe7SPuh+lUriPuh+lZriPugAAj7qPuh+hj7pSuB+hj7qPugAAj7pmuB8lXLyPuh8hj7pmuAAAXLyPuh+hXLxcvB8le71cvAAAXLyPuh8hj7pcvAAAZrh7vR8hUrhcvB8hAABcvB8hAAB7vR8lUjhcvB8ljzqPuh8hZjyPuh8lXDyPuh8hjz5muB8hjz5StAAAhT5StB8lrj97tB8hXEAAAAAAYUAAAAAAXEBmOB8l7EBmOB8lpD+POh8lez2POgAAXDxcPB8hjzpcPB8hAAB7PR8hAABxPR8lUrRcPB8hZrx7PR8hcb1cPB8pj757Pa4nYcBcPB8lXMB7PR8lYcCPOh+hpL9SOAAApL97NAAAj75SNB8hXLwAAB+pe71StB+lAABmuCmwZjhmuK6rjzpSuB+pXDx7tK6nXDxStHusZjxStK6n",
  },
  {
    id: signatureId("NRrv1icljEy_KElPn0GnB"),
    x: 30.7588,
    y: 23.4777,
    isClosed: false,
    path: "AAAAAM3MDD/NzMw9AABSNAAAUrRmOAAAAABcPAAAAABcPK4rAABcPK4rAACPOq6n",
  },
  {
    id: signatureId("vzAQkZcpUOMhyeAj7TfTL"),
    x: 31.0304,
    y: 14.0878,
    isClosed: false,
    path: "AAAAAM3MDD/NzMw9AABSOAAAAACPOgAAUjSPOgAAAACPOgAAezSPOgAAUjSPOmaqUjRcPK6nezRcPB+hUjhmPAAAezSPOgAAUjiPOh+hUjRSOAAAZjhmOB8ljzpSOB8ljzpmOB8hjzpSNAAAjzp7NB8lXDwAAB8hXDxSNB8hZjwAAB8lhT4AAB8lez0AAB8lXDwAAAAAez0AAB8lcT1StB8hZjxmuB8lcT1muB8hjzpSuB8hjzpmuB8hZjiPuh8hUjRSuK4nAACPuh8lUjRmuB8lUrRmuB8lZrhSuB8lUrhStB8lj7p7tB8hXLxStB8pe70AAB8le70AAB8lhb4AAB8lj74AAB8hj75SNB8he71mOB8hpL9SOB+hXLx7NAAAe72POgAAj7pSOB8hUriPOh+lAACPOh+hAACPOgAAjzqPOh+hcT1mOB+lez1SOB+hcT1mOB+hjz4AAHusjz5SNK6nez0AAK6njz5SuMOtcT2Pumaqjz5mvK6nez1xvR+l",
  },
  {
    id: signatureId("2fFF6jTHq2tZ-b2tBYic2"),
    x: 63.6283,
    y: -0.2578,
    isClosed: false,
    path: "cT2KvnE9ij6PwvU9e7R7NB8lUrRSOB8lZrhmPB8hUriFPh8lZriuPx8lUrhcQB8he7R2QR8hUrh2QR8pAACPQq4ne7TsQB8lAAB2QR8lAABhQB8lezRcQB8hUjSPPh8hUjRxPa6nZjiPOh+hUjRStB+hAABcvAAAAACPuh+lAABcvB+hAABmvB+hAABxvR8lAABcvAAAAABmvB+hAACPuh8hAABxvR8hAABcvB8hUjRmuB8lezQAAAAAUjhmOAAAezSPOh8hUjh7OgAAZjiPOh8hjzpmPB8ljzpcPB8ljzqPOh8hjzpSOB8hUjhmOB8hjzpSNB8hjzp7NB8hjzoAAK4nezRmuB8hUjRmuB8hAABSuK6nAACPuh+lAACPugAAAACPuh+hAABcvB+pAABmuB+p",
  },
];

export function isPublicSignature(id: Drawing["id"]) {
  return id === PUBLIC_SIGNATURE_GROUP || originalStrokes.some((stroke) => stroke.id === id);
}

export type LandingPageMessage = {
  type: string;
  diff?: Partial<Record<TLPageId, readonly [operation: string, ...changes: unknown[]]>>;
};

export function discardLandingPageDeletion(
  message: LandingPageMessage | undefined,
  protectedPage: TLPageId,
) {
  if (message?.type !== "push") return;
  const removal = message.diff?.[protectedPage];
  if (!Array.isArray(removal) || removal[0] !== "remove") return;
  // WARNING: Clear the diff rather than dropping just the page operation; tldraw must discard the whole optimistic deletion.
  message.diff = {};
}

export function placePublicSignature(store: TLSyncStorageTransaction<TLRecord>, page: TLPageId) {
  const last = [...store.values()]
    .filter((record) => record.typeName === "shape")
    .filter((drawing) => drawing.parentId === page && !isPublicSignature(drawing.id))
    .sort(sortByIndex)
    .at(-1);

  const group: SignatureGroup = {
    id: PUBLIC_SIGNATURE_GROUP,
    index: getIndexAbove(last?.index),
    isLocked: true,
    meta: {},
    opacity: 1,
    parentId: page,
    props: {},
    rotation: 0,
    type: "group",
    typeName: "shape",
    x: 334,
    y: 436,
  };
  store.set(group.id, group);

  let index = getIndexAbove();
  for (const { id, isClosed, path, x, y } of originalStrokes) {
    const stroke: SignatureStroke = {
      id,
      index,
      isLocked: true,
      meta: {},
      opacity: 1,
      parentId: group.id,
      props: { ...PEN, isClosed, segments: [{ path, type: "free" }] },
      rotation: 0,
      type: "draw",
      typeName: "shape",
      x,
      y,
    };
    store.set(id, stroke);
    index = getIndexAbove(index);
  }
}
