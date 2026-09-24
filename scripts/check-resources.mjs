import { readFile } from "node:fs/promises";

const resources = [
  "themes/github-dark-pro.json",
  "examples/compact-tools.json",
  "examples/compact-tools-2.json",
  "schemas/compact-tools.schema.json",
  "release-notes.json",
];

for (const path of resources) {
  const value = JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
}

const theme = JSON.parse(
  await readFile(new URL("../themes/github-dark-pro.json", import.meta.url), "utf8"),
);
if (theme.name !== "github-dark-pro" || !theme.colors || typeof theme.colors !== "object") {
  throw new Error("themes/github-dark-pro.json is not a valid pi theme document");
}
if (!theme.colors.border || !theme.colors.dim || !theme.colors.muted) {
  throw new Error("github-dark-pro must define separator colors");
}
if (!theme.vars?.thinkingText || !theme.colors.thinkingMax) {
  throw new Error("github-dark-pro must define thinking text and summary colors");
}
if (!theme.colors.mdQuote || !theme.colors.mdCodeBlockBorder) {
  throw new Error("github-dark-pro must define thinking detail and code fence colors");
}

const example = JSON.parse(
  await readFile(new URL("../examples/compact-tools.json", import.meta.url), "utf8"),
);
if (!example.auto_compact || example.auto_compact.edit !== false) {
  throw new Error("example auto_compact policy must keep edit diffs visible by default");
}
if (Object.values(example.auto_compact).some((enabled) => typeof enabled !== "boolean")) {
  throw new Error("example auto_compact values must be booleans");
}
if (!Number.isInteger(example.previewLines) || example.previewLines < 1 || example.previewLines > 100) {
  throw new Error("example previewLines must be an integer from 1 to 100");
}
const alternateExample = JSON.parse(
  await readFile(new URL("../examples/compact-tools-2.json", import.meta.url), "utf8"),
);
for (const [name, config] of [["compact-tools", example], ["compact-tools-2", alternateExample]]) {
  if ("durationIndicators" in config) {
    throw new Error(`${name} must not contain the removed durationIndicators setting`);
  }
  if ("spinner" in config) {
    throw new Error(`${name} must not contain the removed spinner setting`);
  }
}

const schema = JSON.parse(
  await readFile(new URL("../schemas/compact-tools.schema.json", import.meta.url), "utf8"),
);
if (schema.properties?.durationIndicators) {
  throw new Error("schema must not expose the removed durationIndicators setting");
}
if (schema.properties?.spinner) {
  throw new Error("schema must not expose the removed spinner setting");
}
if (!schema.properties?.auto_compact?.properties?.edit) {
  throw new Error("schema must describe per-tool auto_compact policies");
}
if (schema.properties?.previewLines?.default !== 10) {
  throw new Error("schema must expose the bounded previewLines setting");
}

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseNotes = JSON.parse(await readFile(new URL("../release-notes.json", import.meta.url), "utf8"));
// Every published version needs an entry. An empty list is a quiet release that shows no notice.
if (!Array.isArray(releaseNotes[manifest.version]) ||
    releaseNotes[manifest.version].some((note) => typeof note !== "string" || !note.trim())) {
  throw new Error(`release-notes.json must have an entry for v${manifest.version} before publishing; use [] for no notice`);
}

console.log("Resource checks passed");
