import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const generated = new URL("../generated/", import.meta.url);
const repo = new URL("../../../", import.meta.url);
const [workosPort = "18621"] = process.argv.slice(2);
await mkdir(generated, { recursive: true });

const config = JSON.parse(await readFile(new URL("wrangler.json", repo), "utf8"));
delete config.$schema;
config.main = "../../../src/index.ts";
config.assets.directory = "./site";
config.d1_databases[0].migrations_dir = "../../../migrations";
config.workers_dev = false;
await writeFile(new URL("tabletop.json", generated), JSON.stringify(config, null, 2));

const env = await readFile(new URL("e2e/standalone.env", repo), "utf8");
await writeFile(
  new URL(".dev.vars", generated),
  env.replace(/^WORKOS_API_BASE=.*$/m, `WORKOS_API_BASE=http://localhost:${workosPort}`) +
    "\nDISPLAY_NAME=Tabletop\n",
  { mode: 0o600 },
);

const html = await readFile(new URL("site/index.html", generated), "utf8");
const preloadTemplate = html.match(/<template data-board-preloads>(.*?)<\/template>/s)?.[1] ?? "";
const document = html.replace(preloadTemplate, "");
const attrs = (tag) =>
  Object.fromEntries(
    Array.from(tag.matchAll(/([\w-]+)="([^"]*)"/g), ([, name, value]) => [name, value]),
  );
const links = (markup) => Array.from(markup.matchAll(/<link\b[^>]+>/g), ([tag]) => attrs(tag));
const entry = Array.from(document.matchAll(/<script\b[^>]+>/g), ([tag]) => attrs(tag)).find(
  ({ type, src }) => type === "module" && src?.startsWith("/assets/"),
)?.src;
const styles = links(document)
  .filter(({ rel }) => rel === "stylesheet")
  .map(({ href }) => href);
const preloads = links(preloadTemplate).map(({ rel, href, as = "", type = "" }) => ({
  rel,
  href,
  as,
  type,
}));
if (!entry || styles.length === 0 || preloads.length === 0) {
  throw new Error(
    `Missing Vite assets in ${resolve("experiments/opennext/generated/site/index.html")}`,
  );
}

const shell = { entry, styles, preloads, language: "en", name: "Tabletop" };
await writeFile(new URL("shell.json", generated), JSON.stringify(shell, null, 2));
