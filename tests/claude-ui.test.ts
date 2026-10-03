import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";

// These expectations come from tests/fixtures/claude-code-2.1.288.md, captured
// from the native UI. Keep them independent of the generated golden recorder.
const plain = (lines: string[]) => lines.map(stripTerminalSequences).filter((line) => line.trim());

test("Claude 2.1.288 Bash chrome and three-line preview match the live reference", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const row = makeRow("bash", "preview", { command: "fixture-preview" }, harness.definitions.get("bash"));
		row.updateResult({ ...text(Array.from({ length: 12 }, (_, i) => `preview line ${String(i + 1).padStart(2, "0")}`).join("\n")), isError: false } as never);
		for (const width of [44, 100]) {
			const lines = plain(row.render(width));
			assert.deepEqual(lines, [" ⦁ Bash(fixture-preview)", "   ⎿  preview line 01", "      preview line 02", "      preview line 03", "      … +9 lines (ctrl+o to expand)"]);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		// Narrow panes cut the "more" line rather than letting it run past the edge.
		for (const width of [12, 20, 33, 36]) {
			assert.ok(row.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
		}
		row.setExpanded(true);
		const opened = plain(row.render(100));
		assert.equal(opened.length, 13);
		assert.equal(opened.at(-1), "      preview line 12");
		assert.ok(!opened.some((line) => line.includes("ctrl+o")));
	} finally { shutdown(harness); }
});

test("Claude 2.1.288 empty and failed Bash results retain their wording", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const empty = makeRow("bash", "empty", { command: "empty-fixture" }, harness.definitions.get("bash"));
		empty.updateResult({ ...text("(no output)"), isError: false } as never);
		assert.deepEqual(plain(empty.render(100)), [" ⦁ Bash(empty-fixture)", "   ⎿  (No output)"]);
		const failed = makeRow("bash", "failed", { command: "failed-fixture" }, harness.definitions.get("bash"));
		failed.updateResult({ ...text("fixture failure\n\nCommand exited with code 2"), isError: true } as never);
		assert.deepEqual(plain(failed.render(100)), [" ⦁ Bash(failed-fixture)", "   ⎿  Error: Exit code 2", "      fixture failure"]);
	} finally { shutdown(harness); }
});

test("a finished Claude exploration folds into one dotted line that a click opens", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const read = makeRow("read", "read", { path: "README.md" }, harness.definitions.get("read"));
		const grep = makeRow("grep", "grep", { pattern: "fixture", path: "extensions" }, harness.definitions.get("grep"));
		for (const row of [read, grep]) row.updateResult({ ...text("fixture"), isError: false } as never);
		harness.chat.children = [read, grep];
		const rendered = harness.chat.render(100);
		assert.deepEqual(plain(rendered), [" ⦁ Searched for 1 pattern, read 1 file (click to expand)"]);
		read.setExpanded(true);
		grep.setExpanded(true);
		assert.ok(plain(harness.chat.render(100)).some((line) => line.includes("⦁ Read(README.md)")), "Ctrl+O still reveals the rows");
	} finally { shutdown(harness); }
});

// Claude Code puts "⎿" under the tool's name. Pi draws one column in, so all of
// it moves together.
test("Claude chrome lines up under the tool name, with no compact rail", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const longCommand = `echo ${"wrapped ".repeat(12)}`.trim();
		const bash = makeRow("bash", "align-bash", { command: longCommand }, harness.definitions.get("bash"));
		bash.updateResult({ ...text("ok"), isError: false } as never);
		const lines = plain(bash.render(44));
		const nameColumn = lines[0]!.indexOf("Bash");
		const result = lines.find((line) => line.includes("⎿"))!;
		assert.equal(result.indexOf("⎿"), nameColumn, "⎿ under the name");
		for (const line of lines.slice(1, lines.indexOf(result))) {
			assert.ok(line.startsWith(" ".repeat(nameColumn)) && !line.includes("│"), `wrapped call line: ${JSON.stringify(line)}`);
		}

		const read = makeRow("read", "align-read", { path: "README.md" }, harness.definitions.get("read"));
		read.updateResult({ ...text("one\ntwo"), isError: false } as never);
		harness.chat.children = [read];
		const summary = plain(harness.chat.render(100))[0]!;
		assert.equal(summary.indexOf("Read 1 file"), nameColumn, "a group's summary starts where a name does");
		read.setExpanded(true);
		const opened = plain(harness.chat.render(100));
		assert.ok(!opened.some((line) => line.includes("│")), JSON.stringify(opened));
		assert.ok(opened.some((line) => /^ {6}\s*1\s+one/u.test(line)), "the opened read sits under its result");
	} finally { shutdown(harness); }
});

test("a long Claude failure wraps at words and keeps every character", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const reason = "Could not find the exact text in src/app.ts. The old text must match exactly including all whitespace and newlines.";
		const row = makeRow("edit", "wrap-failure", { path: "src/app.ts", edits: [] }, harness.definitions.get("edit"));
		row.updateResult({ ...text(reason), isError: true } as never);
		for (const width of [44, 80, 120, 121]) {
			const lines = plain(row.render(width));
			const words = lines.slice(1).map((line) => line.replace(/^ {3}⎿ {2}| {6}/u, "")).join(" ");
			assert.equal(words, `Error: ${reason}`, `width ${width}: every word whole, in order`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
		}
	} finally { shutdown(harness); }
});

test.after(restoreClocks);
