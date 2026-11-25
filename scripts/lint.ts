import baseline from "../oxlint-warning-baseline.json" with { type: "json" };

type Diagnostic = {
  code: string;
  filename: string;
  labels: { span: { line: number; column: number } }[];
  message: string;
  severity: "error" | "warning";
};

const result = Bun.spawnSync(
  ["oxlint", "-c", "oxlint.config.ts", "--format", "json", "client", "src", "alchemy", "e2e"],
  { stderr: "inherit" },
);

const output = result.stdout.toString();
let diagnostics: Diagnostic[];
try {
  diagnostics = JSON.parse(output).diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("Missing Oxlint diagnostics");
} catch {
  console.error(output || "Oxlint did not return diagnostics.");
  process.exit(result.exitCode || 1);
}

const remaining = new Map(Object.entries(baseline));
let existing = 0;
let failures = 0;
for (const diagnostic of diagnostics) {
  const { code, filename, labels, message, severity } = diagnostic;
  const key = filename.replaceAll("\\", "/") + " " + code;
  const allowance = remaining.get(key) ?? 0;

  if (severity === "warning" && allowance > 0) {
    remaining.set(key, allowance - 1);
    existing++;
    continue;
  }

  const location = labels[0]?.span;
  const file = location ? `${filename}:${location.line}:${location.column}` : filename;
  console.error(`${file}: ${severity} ${code}: ${message}`);
  failures++;
}

console.log(
  `Oxlint reported ${failures} new warnings or errors and ${existing} existing warnings.`,
);
process.exit(result.exitCode || (failures > 0 ? 1 : 0));
