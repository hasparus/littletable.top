import { MAX_NAME_LENGTH, MAX_TITLE_LENGTH } from "./limits";

// Whitespace runs become one space; control and format characters, and a
// name with none left, are refused.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;

function clean(text: unknown, max: number): string | null {
  if (typeof text !== "string") return null;
  const cleaned = text.split(/\s+/u).filter(Boolean).join(" ");
  if (cleaned === "" || cleaned.length > max || UNPRINTABLE.test(cleaned)) return null;
  return cleaned;
}

export const cleanName = (name: unknown) => clean(name, MAX_NAME_LENGTH);
export const cleanTitle = (title: unknown) => clean(title, MAX_TITLE_LENGTH);
