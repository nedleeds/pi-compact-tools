import { readFile } from "node:fs/promises";

const resources = [
  "themes/github-dark-pro.json",
  "examples/compact-tools.json",
  "examples/compact-tools-2.json",
  "schemas/compact-tools.schema.json",
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
  throw new Error("github-dark-pro must define spinner and separator colors");
}
if (!theme.vars?.thinkingText) {
  throw new Error("github-dark-pro must define a distinct thinking text color");
}

const example = JSON.parse(
  await readFile(new URL("../examples/compact-tools.json", import.meta.url), "utf8"),
);
if (!Array.isArray(example.spinner?.frames) || example.spinner.frames.length === 0) {
  throw new Error("example spinner.frames must be a non-empty array");
}
if (!Number.isInteger(example.spinner.intervalMs)) {
  throw new Error("example spinner.intervalMs must be an integer");
}
if (!example.auto_compact || example.auto_compact.edit !== false) {
  throw new Error("example auto_compact policy must keep edit diffs visible by default");
}
if (Object.values(example.auto_compact).some((enabled) => typeof enabled !== "boolean")) {
  throw new Error("example auto_compact values must be booleans");
}
const blinkExample = JSON.parse(
  await readFile(new URL("../examples/compact-tools-2.json", import.meta.url), "utf8"),
);
if (JSON.stringify(blinkExample.spinner?.frames) !== JSON.stringify(["●", "●", " ", "●", "●"])) {
  throw new Error("compact-tools-2 spinner must fade through repeated circles and a blank frame");
}
if (
  !Array.isArray(blinkExample.durationIndicators) ||
  blinkExample.durationIndicators.some((indicator) => indicator.icon !== "•") ||
  blinkExample.durationIndicators[0]?.color !== "#E0A052"
) {
  throw new Error("compact-tools-2 must use bullet duration indicators and the explicit warning hex color");
}
const indicators = example.durationIndicators;
if (!Array.isArray(indicators) || indicators.length === 0 || indicators.at(-1)?.underMs !== undefined) {
  throw new Error("example durationIndicators must end with a fallback rule");
}
for (let index = 0; index < indicators.length - 1; index++) {
  if (!(indicators[index].underMs > (indicators[index - 1]?.underMs ?? 0))) {
    throw new Error("example durationIndicators thresholds must be ascending");
  }
}
if (indicators.some((indicator) => indicator.color !== undefined && typeof indicator.color !== "string")) {
  throw new Error("example duration indicator colors must be strings");
}

const schema = JSON.parse(
  await readFile(new URL("../schemas/compact-tools.schema.json", import.meta.url), "utf8"),
);
if (!schema.properties?.durationIndicators?.items?.properties?.color) {
  throw new Error("schema must describe durationIndicators.color");
}
if (!schema.properties?.auto_compact?.properties?.edit) {
  throw new Error("schema must describe per-tool auto_compact policies");
}

console.log("Resource checks passed");
