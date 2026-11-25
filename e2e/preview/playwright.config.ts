import { defineConfig } from "@playwright/test";

const baseURL = process.env.PREVIEW_URL;
if (!baseURL) throw new Error("Set PREVIEW_URL to the deployed preview origin.");

export default defineConfig({
  outputDir: "../test-results/preview",
  testMatch: "public-board.spec.ts",
  use: {
    baseURL,
    screenshot: "only-on-failure",
  },
});
