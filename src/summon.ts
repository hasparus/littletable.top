import { pageIdValidator } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

export const MAX_SUMMON_BYTES = 1024;

const coordinate = T.number.check((value) => {
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("View is out of bounds");
});

const viewFields = {
  page: pageIdValidator,
  x: coordinate,
  y: coordinate,
  zoom: T.number.check((value) => {
    if (value < 0.001 || value > 1000) throw new Error("Zoom is out of bounds");
  }),
};

export const summonView = T.object(viewFields);
export const summonMessage = T.object({ type: T.literal("summon"), ...viewFields });
export type SummonView = T.TypeOf<typeof summonView>;
