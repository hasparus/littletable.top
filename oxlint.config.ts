import baseConfig, { ignorePatterns } from "@hasparus/oxlint-config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "oxlint";

const tailwindEntryPoint = fileURLToPath(new URL("client/src/app.css", import.meta.url));

export default defineConfig({
  extends: [baseConfig],
  options: { typeAware: false },
  ignorePatterns: [...ignorePatterns, "e2e/test-results", "e2e/report"],
  jsPlugins: ["@shadcn/lint"],
  overrides: [
    // The Worker logs one JSON line per event to the console, which is what
    // Workers Logs collects, and the fakes are server processes; the
    // Worker entry's default export is the Workers module format.
    {
      files: ["src/**/*.ts", "e2e/fake-host.ts", "e2e/fake-workos.ts"],
      rules: { "no-console": "off" },
    },
    { files: ["src/index.ts"], rules: { "import/no-default-export": "off" } },
    {
      files: ["client/src/**/*.tsx"],
      rules: {
        "shadcn/no-arbitrary-values": ["error", { deny: ["shadow"] }],
        "shadcn/no-raw-colors": "error",
      },
    },
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
