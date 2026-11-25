export type Language = "en" | "pl";

/** The six colours a deployer may set; the rest of the palette is neutral. */
export type Brand = {
  primary: string;
  primaryHover: string;
  /** A pale wash of the primary, under selected and soft controls. */
  primaryLight: string;
  primaryLightDark: string;
  /** Text and marks on primaryLight. */
  primaryStrong: string;
  primaryStrongDark: string;
};

export type HostedSettings = {
  /** The host's pass endpoint, "{code}" standing for the board's share code. */
  bootstrapUrl: string;
  /** Where a person goes from a board before the host has said whose it is. */
  exitUrl: string;
};

/** One build-time settings value feeds the client constants, manifest, page title and brand. */
export type ClientSettings = {
  brand: Partial<Brand>;
  description: string;
  hosted: HostedSettings | null;
  /** The language when neither the address nor the browser names one. */
  language: Language;
  /** tldraw's licence key; public by design, tldraw ties it to the domain. */
  licenseKey: string;
  mode: "hosted" | "standalone";
  name: string;
  shortName: string;
};

export const DEFAULT_SETTINGS: ClientSettings = {
  brand: {},
  description: "A shared whiteboard with dice, for games at the table and online.",
  hosted: null,
  language: "en",
  licenseKey: "",
  mode: "standalone",
  name: "Tabletop",
  shortName: "Tabletop",
};

export const BRAND_PROPERTIES: Record<keyof Brand, string> = {
  primary: "--brand-primary",
  primaryHover: "--brand-primary-hover",
  primaryLight: "--brand-primary-light",
  primaryLightDark: "--brand-primary-light-dark",
  primaryStrong: "--brand-primary-strong",
  primaryStrongDark: "--brand-primary-strong-dark",
};

/** The light theme's page colour: the browser's toolbar and splash screen. */
export const THEME_COLOR = "#f7f6f3";
