#!/usr/bin/env node
// Keep Pi 1.5's native changelog in sync with the legacy notices/GitHub notes.
import { readFile, writeFile } from "node:fs/promises";

export function changelogMarkdown(notes) {
  const sections = ["New", "Fix", "Deprecated"];
  const versions = Object.keys(notes).sort((left, right) => {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
  const entries = versions.flatMap((version) => {
    const entry = notes[version];
    const groups = Array.isArray(entry)
      ? (entry.length ? [entry.map((note) => `- ${note}`).join("\n")] : [])
      : sections.flatMap((section) => entry[section]?.length
        ? [`### ${section}\n\n${entry[section].map((note) => `- ${note}`).join("\n")}`] : []);
    return groups.length ? [`## [${version}]\n\n${groups.join("\n\n")}`] : [];
  });
  return `# Changelog\n\n${entries.join("\n\n")}\n`;
}

const notes = JSON.parse(await readFile(new URL("../release-notes.json", import.meta.url), "utf8"));
const target = new URL("../CHANGELOG.md", import.meta.url);
const expected = changelogMarkdown(notes);
if (process.argv.includes("--check")) {
  const actual = await readFile(target, "utf8").catch(() => "");
  if (actual.replace(/\r\n/g, "\n") !== expected) {
    console.error("CHANGELOG.md is out of sync; run npm run changelog");
    process.exitCode = 1;
  }
} else {
  await writeFile(target, expected);
}
