import { fileURLToPath } from "node:url";

export const SCREENSHOT_DIR =
  process.env.SHOTS_DIR ?? fileURLToPath(new URL("test-results/screenshots", import.meta.url));
