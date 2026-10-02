import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
// Dev-only: the public entry point does not export the theme file parser.
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const root = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + sep) : new URL("../", import.meta.url);
const resources = [
  "package.json", "themes/github-dark-pro.json", "examples/compact-tools.json",
  "examples/compact-tools-2.json", "schemas/compact-tools.schema.json", "release-notes.json",
];
// Read each document once, concurrently. Nothing here is shipped as a runtime dependency.
const documents = Object.fromEntries(await Promise.all(resources.map(async (path) => {
  const value = JSON.parse(await readFile(new URL(path, root), "utf8"));
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${path} must contain a JSON object`);
  return [path, value];
})));
const manifest = documents["package.json"];
const schema = documents["schemas/compact-tools.schema.json"];
const theme = documents["themes/github-dark-pro.json"];
const validate = new Ajv2020({ allErrors: true }).compile(schema);
for (const path of ["examples/compact-tools.json", "examples/compact-tools-2.json"]) {
  assert.ok(validate(documents[path]), `${path}: ${JSON.stringify(validate.errors)}`);
}
assert.equal(documents["examples/compact-tools.json"].auto_compact?.edit, false, "example must keep edit diffs visible");
assert.equal(schema.properties?.previewLines?.default, 10);
assert.ok(schema.properties?.auto_compact?.properties?.edit, "schema must describe per-tool auto_compact");
for (const key of ["durationIndicators", "spinner"]) {
  assert.ok(!Object.hasOwn(schema.properties, key), `schema must not expose removed ${key}`);
}
// Use the host's actual theme parser, including color references, rather than a partial schema copy.
assert.equal(loadThemeFromPath(fileURLToPath(new URL("themes/github-dark-pro.json", root))).name, "github-dark-pro");
for (const key of ["border", "dim", "muted", "thinkingMax", "mdQuote", "mdCodeBlockBorder"]) {
  assert.ok(theme.colors?.[key], `github-dark-pro must define ${key}`);
}
assert.ok(theme.vars?.thinkingText, "github-dark-pro must define thinking text");
const notes = documents["release-notes.json"][manifest.version];
assert.ok(Array.isArray(notes) && notes.every((note) => typeof note === "string" && note.trim()),
  `release-notes.json must have an entry for v${manifest.version}; use [] for no notice`);
assert.ok(manifest.keywords?.includes("pi-package"), "manifest must declare pi-package");
for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
  assert.ok(!Object.hasOwn(manifest.dependencies ?? {}, name), `${name} must not be a bundled runtime dependency`);
}
for (const paths of Object.values(manifest.pi).filter(Array.isArray)) {
  await Promise.all(paths.map((path) => access(new URL(path, root))));
}
console.log("Resource checks passed");
