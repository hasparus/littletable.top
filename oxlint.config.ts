import baseConfig from "@hasparus/oxlint-config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "oxlint";

const tailwindEntryPoint = fileURLToPath(new URL("client/src/app.css", import.meta.url));

export default defineConfig({
  extends: [baseConfig, { options: { typeAware: false } }],
  ignorePatterns: ["dist", "node_modules", "e2e/test-results", "e2e/report"],
  overrides: [
    {
      files: ["client/src/**/*.ts"],
      rules: {
        "no-console": ["warn", { allow: ["warn", "error"] }],
      },
    },
  ],
  settings: {
    "better-tailwindcss": {
      detectComponentClasses: true,
      entryPoint: tailwindEntryPoint,
    },
  },
});
