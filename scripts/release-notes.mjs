#!/usr/bin/env node
// Print a version's release notes as Markdown for the GitHub release:
//   node scripts/release-notes.mjs 0.14.0
// Sections with nothing to say still read "None", so every release has the same shape.
import { readFile } from "node:fs/promises";

const SECTIONS = ["New", "Fix", "Deprecated"];
const version = process.argv[2] ?? JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const notes = JSON.parse(await readFile(new URL("../release-notes.json", import.meta.url), "utf8"))[version];
if (notes === undefined) {
  console.error(`release-notes.json has no entry for ${version}`);
  process.exit(1);
}
const bullets = (items) => (items.length > 0 ? items : ["None"]).map((item) => `- ${item}`).join("\n");
// `###` headings, as Pi's own changelog groups each version's notes.
process.stdout.write(Array.isArray(notes)
  ? `${bullets(notes)}\n`
  : `${SECTIONS.map((section) => `### ${section}\n\n${bullets(notes[section] ?? [])}`).join("\n\n")}\n`);
