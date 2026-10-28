import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import { claudeArgument, claudeOutcome } from "../extensions/compact-tools-claude.ts";
import { claudeRows } from "../extensions/compact-tools-layout.ts";
import { announce, loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";

// These expectations come from tests/fixtures/claude-code-2.1.312.md, captured
// from the native UI. Keep them independent of the generated golden recorder.
const plain = (lines: string[]) => lines.map(stripTerminalSequences).filter((line) => line.trim());

test("Claude 2.1.312 Bash chrome and three-line preview match the live reference", async () => {
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

test("Claude 2.1.312 empty and failed Bash results retain their wording", async () => {
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

test("a finished Claude exploration is muted and dotless, with only counts bold, and a click opens it", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const read = makeRow("read", "read", { path: "README.md" }, harness.definitions.get("read"));
		const grep = makeRow("grep", "grep", { pattern: "fixture", path: "extensions" }, harness.definitions.get("grep"));
		for (const row of [read, grep]) row.updateResult({ ...text("fixture"), isError: false } as never);
		harness.chat.children = [read, grep];
		// Bold can be disabled by chalk in non-TTY test runners. Observe the theme API
		// instead of depending on the runner's color settings.
		const bold = test.mock.method(Theme.prototype, "bold");
		let rendered: string[];
		try {
			rendered = harness.chat.render(100);
			assert.deepEqual(bold.mock.calls.map((call) => call.arguments[0]).filter((value) => value !== "x"), ["1", "1"]);
		} finally { bold.mock.restore(); }
		assert.deepEqual(plain(rendered), ["   Searched for 1 pattern, read 1 file (click to expand)"]);
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
		assert.deepEqual(opened, [" ⦁ Read(README.md)", "   ⎿  Read 2 lines"], "expanded Read keeps only the line count, with no group header or file body");
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

test("Claude Read ranges appear in the expanded title, never as a file-body preview", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		for (const [range, suffix] of [
			[{ limit: 3 }, " · lines 1-3"],
			[{ offset: 6 }, " · from line 6"],
			[{ offset: 5, limit: 4 }, " · lines 5-8"],
			[{}, ""],
		] as const) {
			const row = makeRow("read", `range-${suffix}`, { path: "sample.txt", ...range }, harness.definitions.get("read"));
			row.updateResult({ ...text("row one\nrow two\nrow three"), isError: false } as never);
			assert.deepEqual(plain(row.render(100)), [" ⦁ Read(sample.txt)", "   ⎿  Read 3 lines"]);
			row.setExpanded(true);
			assert.deepEqual(plain(row.render(100)), [` ⦁ Read(sample.txt${suffix})`, "   ⎿  Read 3 lines"]);
		}
	} finally { shutdown(harness); }
});

test("a clicked Claude group drops its cached header when Ctrl+O opens the transcript", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const row = makeRow("read", "clicked-to-host", { path: "sample.txt" }, harness.definitions.get("read"));
		row.updateResult({ ...text("one\ntwo"), isError: false } as never);
		harness.chat.children = [row];
		const click = () => {
			const lines = harness.chat.render(100);
			const y = lines.findIndex((line) => line.includes("Read 1 file"));
			assert.ok(y >= 0);
			const chat = harness.chat as unknown as { handleMouse(event: object): { handled?: boolean } | undefined };
			assert.equal(chat.handleMouse({ type: "click", button: "left", x: 4, y, width: 100, height: lines.length })?.handled, true);
		};
		click();
		assert.ok(plain(harness.chat.render(100)).some((line) => line.includes("Read 1 file")), "local header remains a collapse target");
		click();
		assert.deepEqual(plain(harness.chat.render(100)), ["   Read 1 file (click to expand)"]);
		click();
		harness.chat.render(100); // Cache the locally expanded header.
		row.setExpanded(true);
		assert.deepEqual(plain(harness.chat.render(100)), [" ⦁ Read(sample.txt)", "   ⎿  Read 2 lines"]);
		row.setExpanded(false);
		assert.deepEqual(plain(harness.chat.render(100)), ["   Read 1 file (click to expand)"]);
	} finally { shutdown(harness); }
});

test("Claude follows the last four running Bash rows, then the first three completed rows", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: false });
	try {
		const id = "streaming-preview";
		announce(harness, id, "bash");
		const row = makeRow("bash", id, { command: "stream-fixture" }, harness.definitions.get("bash"));
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "bash", args: {} });
		row.markExecutionStarted();
		row.updateResult({ ...text(""), isError: false } as never, true);
		assert.deepEqual(plain(row.render(100)), [" ⦁ Bash(stream-fixture)", "   ⎿  Running…"]);
		const output = Array.from({ length: 5 }, (_, i) => `stream line ${i + 1}`).join("\n");
		row.updateResult({ ...text(output), isError: false } as never, true);
		for (const width of [1, 3, 10, 20, 44]) assert.ok(row.render(width).every((line) => visibleWidth(line) <= width), `streaming width ${width}`);
		assert.deepEqual(plain(row.render(100)), [" ⦁ Bash(stream-fixture)", "   ⎿  stream line 2", "      stream line 3", "      stream line 4", "      stream line 5", "      +1 lines"]);
		row.setExpanded(true);
		assert.deepEqual(plain(row.render(100)).slice(1), output.split("\n").map((line, index) => `${index ? "      " : "   ⎿  "}${line}`));
		row.setExpanded(false);
		harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
		row.updateResult({ ...text(output), isError: false } as never, false);
		assert.deepEqual(plain(row.render(100)), [" ⦁ Bash(stream-fixture)", "   ⎿  stream line 1", "      stream line 2", "      stream line 3", "      … +2 lines (ctrl+o to expand)"]);
	} finally { shutdown(harness); }
});

test("Claude shell failures without diagnostics keep canonical status when expanded", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		for (const name of ["bash", "powershell", "custom_shell"]) {
			for (const [status, headline] of [
				["Command exited with code 2", "Error: Exit code 2"],
				["Command timed out after 10 seconds", "Error: timed out after 10 seconds"],
				["Command aborted", "Error: aborted"],
				["Command terminated by signal SIGTERM", "Error: terminated by signal SIGTERM"],
			]) {
				const row = makeRow(name, `error-${name}-${status}`, { command: "fixture" }, harness.definitions.get(name));
				row.updateResult({ ...text(status!), isError: true } as never);
				const collapsed = plain(row.render(100));
				assert.equal(collapsed[1], `   ⎿  ${headline}`);
				row.setExpanded(true);
				assert.deepEqual(plain(row.render(100)), collapsed);
			}
		}
	} finally { shutdown(harness); }
});

test("expanded Claude file errors preserve multiline diagnostics without doubling Error", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const output = `Error: Could not find the exact text.\n${"All whitespace must match. ".repeat(8).trim()}`;
		const row = makeRow("edit", "multiline-error", { path: "app.ts", edits: [] }, harness.definitions.get("edit"));
		row.updateResult({ ...text(output), isError: true } as never);
		row.setExpanded(true);
		const rendered = row.render(100).filter((line) => stripTerminalSequences(line).trim());
		const lines = plain(rendered);
		assert.ok(rendered.slice(2).every((line) => /^ {6}\x1b\[/u.test(line)), "every diagnostic row reapplies its error color");
		assert.equal(lines[1], "   ⎿  Error: Could not find the exact text.");
		assert.equal(lines.slice(2).map((line) => line.trim()).join(" "), output.split("\n")[1]);
		assert.ok(!lines.some((line) => line.includes("Error: Error:")));
	} finally { shutdown(harness); }
});

test("Claude Read distinguishes image attachments from text lines", () => {
	assert.equal(claudeOutcome("read", {}, text("one"), "one"), "Read 1 line");
	const image = { content: [{ type: "text" as const, text: "Read image file [image/png]\nResized image" }, { type: "image" as const, data: "", mimeType: "image/png" }], details: undefined };
	assert.equal(claudeOutcome("read", {}, image, "Read image file [image/png]\nResized image"), "Read image");
});

test("Claude ignores invalid Read ranges while rendering failed or incomplete calls", () => {
	for (const value of [0, -1, NaN, Infinity, 1.5]) {
		assert.equal(claudeArgument("read", { path: "sample.txt", offset: value, limit: 3 }, true), "sample.txt");
		assert.equal(claudeArgument("read", { path: "sample.txt", limit: value }, true), "sample.txt");
	}
});

test("Claude running previews count wrapped rows and keep the exact four-row boundary", () => {
	const preview = (lines: string[], width: number) => claudeRows(lines, "> ", "  ", 4, (hidden) => `+${hidden} lines`, undefined, true).render(width);
	assert.deepEqual(preview(["1", "2", "3", "4"], 100), ["> 1", "  2", "  3", "  4"]);
	assert.deepEqual(preview(["0123456789".repeat(5)], 20), ["> 0123456789", "  0123456789", "  0123456789", "  0123456789", "  +1 lines"]);
	for (const width of [10, 20, 44]) {
		assert.ok(preview(["한글 😀 ".repeat(20)], width).every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
});

test.after(restoreClocks);
