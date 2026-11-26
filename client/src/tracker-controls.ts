export const MAX_TRACKER_SEATS = 24;

export const SPOTLIGHT_STEP = 10;

export function spotlightLevel(marks: number) {
  return Math.max(0, Math.min(100, Math.round(marks / SPOTLIGHT_STEP) * SPOTLIGHT_STEP));
}

export type TrackerSeat = { id: number; name: string; marks: number };
export type TrackerControls = {
  seats: TrackerSeat[];
  active: number;
  select: (id: number) => void;
  rename: (id: number, name: string) => void;
  add: () => void;
  remove: (id: number) => void;
  setValue: (id: number, value: number) => void;
  reorder: (from: number, to: number) => void;
  readonly: boolean;
  locale: string;
  preview: string;
  token?: string;
  portraits?: readonly string[];
};
