import { readFile } from "node:fs/promises";

const resources = [
  "themes/github-dark-pro.json",
  "examples/compact-tools.json",
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

console.log("Resource checks passed");
