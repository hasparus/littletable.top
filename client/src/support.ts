import { createContext, useContext } from "react";

import type { Language } from "../settings";

export const SUPPORT_URL = "/docs/?support";
export const SupportContext = createContext<string | null>(null);

export function supportLabel(language: Language) {
  return language === "pl" ? "Otwórz pomoc w nowej karcie" : "Open support in a new tab";
}

export function useSupport() {
  return useContext(SupportContext);
}
