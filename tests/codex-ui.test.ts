import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { generateDiffString, generateUnifiedPatch } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
	advance, announce, INDICATOR_INTERVAL_MS, loadExtension, makeRow, restoreClocks, shutdown, text, timerClock, type Harness,
} from "./indicator-harness.ts";

// These expectations come from tests/fixtures/codex-0.160.0.md, captured from the
// native UI in a 120-column pane. Pi draws every row one column in, so at 121 columns
// each Pi line is Codex's line after one column of margin, with Pi's own key in the
// hint. Keep them independent of the generated golden recorder.
const CODEX_WIDTH = 120;
const PI_WIDTH = CODEX_WIDTH + 1;
const asPi = (lines: string[]) => lines.map((line) => ` ${line}`.replace("ctrl+t", "ctrl+o").trimEnd());
/** What a row draws, as text: Pi's spacer above it dropped, tinted rows' padding trimmed. */
const drawn = (lines: string[]) => {
	const plain = lines.map((line) => stripTerminalSequences(line).trimEnd());
	while (plain[0] === "") plain.shift();
	return plain;
};
const WIDTHS = [8, 12, 20, 33, 44, 80, 120];

let sequence = 0;

/** A call run to its end as Pi runs it, `elapsed` ms after it started. */
function finished(harness: Harness, name: string, args: object, result: object, isError = false, elapsed = 0) {
	const id = `codex-${name}-${++sequence}`;
	announce(harness, id, name);
	const row = makeRow(name, id, args, harness.definitions.get(name));
	row.setArgsComplete();
	harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: name, args });
	row.markExecutionStarted();
	advance(elapsed);
	harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError });
	row.updateResult({ ...result, isError } as never, false);
	return row;
}

const bash = (harness: Harness, command: string, output: string, isError = false, elapsed = 0) =>
	finished(harness, "bash", { command }, text(output), isError, elapsed);

/** At every width a pane might have, no row runs past its edge. */
function fits(row: { render(width: number): string[] }, label: string): void {
	for (const width of WIDTHS) {
		for (const line of row.render(width)) assert.ok(visibleWidth(line) <= width, `${label} at ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
	}
}

const SEQ = Array.from({ length: 12 }, (_, index) => String(index + 1)).join("\n");
const LONG = "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjjj kkkkkkkkkk llllllllll mmmmmmmmmm nnnnnnnnnn";

test("Codex 0.160.0 commands, collapsed, match the live reference character for character", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		const seq = bash(harness, "seq 1 12", SEQ);
		assert.deepEqual(drawn(seq.render(PI_WIDTH)), asPi([
			"• Ran seq 1 12", "  └ 10", "    11", "    12", "    + 9 lines (ctrl+t to expand)",
		]));
		assert.deepEqual(drawn(bash(harness, "true", "(no output)").render(PI_WIDTH)), asPi(["• Ran true", "  └ (no output)"]));
		const failed = bash(harness, "sh -c 'echo fixture failure >&2; exit 2'", "fixture failure\n\n\nCommand exited with code 2", true);
		assert.deepEqual(drawn(failed.render(PI_WIDTH)), asPi([
			"• Failed (exit 2) sh -c 'echo fixture failure >&2; exit 2'", "  └ fixture failure",
		]));
		// A header and an output line too wide for the row are cut with "…", and the cut line counts as hidden.
		const wide = bash(harness, `echo ${LONG}`, LONG);
		assert.deepEqual(drawn(wide.render(PI_WIDTH)), asPi([
			"• Ran echo aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjj…",
			"  └ aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjjj kkkkk…",
			"    + 1 line (ctrl+t to expand)",
		]));
		for (const [row, label] of [[seq, "seq"], [failed, "failed"], [wide, "wide"]] as const) fits(row, label);
	} finally { shutdown(harness); }
});

test("Codex 0.160.0 commands, opened, read as its transcript", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		const wide = bash(harness, `echo ${LONG}`, LONG);
		wide.setExpanded(true);
		assert.deepEqual(drawn(wide.render(PI_WIDTH)), asPi([
			"$ echo aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjjj",
			"    kkkkkkkkkk llllllllll mmmmmmmmmm nnnnnnnnnn",
			"aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjjj kkkkkkkkkk",
			"llllllllll mmmmmmmmmm nnnnnnnnnn",
			"✓ • 0ms",
			"    − Show less",
		]));
		const seq = bash(harness, "seq 1 12", SEQ);
		seq.setExpanded(true);
		assert.deepEqual(drawn(seq.render(PI_WIDTH)), asPi(["$ seq 1 12", ...SEQ.split("\n"), "✓ • 0ms", "    − Show less"]));
		const failed = bash(harness, "sh -c 'seq 1 5; exit 2'", "1\n2\n3\n4\n5\n\nCommand exited with code 2", true, 12);
		failed.setExpanded(true);
		assert.deepEqual(drawn(failed.render(PI_WIDTH)), asPi(["$ sh -c 'seq 1 5; exit 2'", "1", "2", "3", "4", "5", "✗ (2) • 12ms", "    − Show less"]));
		const timed = bash(harness, "make", SEQ, false, 75_000);
		timed.setExpanded(true);
		assert.ok(drawn(timed.render(PI_WIDTH)).includes(" ✓ • 1m 15s"), "Codex's minutes");
		// In the live reference, Enter on `• Ran true` or a short failure changes nothing: Codex opens only a call
		// whose preview leaves something out. Pi's Ctrl+O opens every row, so these keep their preview.
		const quiet = [
			[bash(harness, "true", "(no output)"), ["• Ran true", "  └ (no output)"]],
			[bash(harness, "sh -c 'echo fixture failure >&2; exit 2'", "fixture failure\n\nCommand exited with code 2", true),
				["• Failed (exit 2) sh -c 'echo fixture failure >&2; exit 2'", "  └ fixture failure"]],
			[bash(harness, "cat README.md", "# Lab\n\nA tiny fixture project.\n"), ["• Ran cat README.md", "  └ # Lab", "", "    A tiny fixture project."]],
		] as const;
		for (const [row, lines] of quiet) {
			row.setExpanded(true);
			assert.deepEqual(drawn(row.render(PI_WIDTH)), asPi([...lines]), lines[0]);
		}
		// What a narrow pane cuts is left out, so there it opens.
		assert.equal(drawn(quiet[1][0].render(30))[0], " $ sh -c 'echo fixture failure");
		for (const [row, label] of [[wide, "wide"], [seq, "seq"], [failed, "failed"], [quiet[2][0], "readme"]] as const) fits(row, label);
		// A click on the result closes it again, as on any of Pi's rows.
		wide.setExpanded(false);
		assert.equal(drawn(wide.render(PI_WIDTH))[0], " • Ran echo aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjj…");
	} finally { shutdown(harness); }
});

test("Codex 0.160.0 exploration folds reads, searches, and listings into one group", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		harness.chat.children = [
			bash(harness, "sed -n 1,200p README.md", "# Lab"),
			bash(harness, "cat docs/notes.md", "Notes line 1"),
			finished(harness, "read", { path: "src/util.ts" }, text("x")),
			bash(harness, "rg -n 'export' src", "src/app.ts:1:export"),
			finished(harness, "ls", { path: "docs" }, text("notes.md")),
		];
		assert.deepEqual(drawn(harness.chat.render(PI_WIDTH)), asPi([
			"• Explored", "  └ Read README.md, notes.md, util.ts", "    Search export in src", "    List docs", "    + Show details",
		]));
		for (const width of WIDTHS) {
			for (const line of harness.chat.render(width)) assert.ok(visibleWidth(line) <= width, `group at ${width}`);
		}
		// A failed call ends its line with its exit code and counts in the head; a search's exit 1 is quiet.
		harness.chat.children = [
			bash(harness, "rg missing src", "\n\nCommand exited with code 1", true),
			bash(harness, "cat gone.txt", "cat: gone.txt: No such file\n\nCommand exited with code 2", true),
			bash(harness, "cat nope.txt", "cat: nope.txt: No such file\n\nCommand exited with code 1", true),
		];
		const failed = harness.chat.render(PI_WIDTH);
		assert.deepEqual(drawn(failed), asPi([
			"• Explored · 3 failed", "  └ Search missing in src (exit 1)", "    Read gone.txt (exit 2)", "    Read nope.txt (exit 1)", "    + Show details",
		]));
		const colorOf = (line: string, part: string) => {
			const drawnLine = failed.find((each) => stripTerminalSequences(each).includes(line))!;
			return new RegExp(`(\\x1b\\[[0-9;]*m)${part.replace(/[()]/gu, "\\$&")}`, "u").exec(drawnLine)?.[1];
		};
		const red = theme.fg("error", "x").slice(0, -"x\x1b[39m".length);
		assert.equal(colorOf("gone.txt", " (exit 2)"), red, "a failure is red");
		assert.equal(colorOf("nope.txt", " (exit 1)"), red, "a read's exit 1 is a failure too");
		assert.notEqual(colorOf("missing", " (exit 1)"), red, "only a search that found nothing is quiet");
	} finally { shutdown(harness); }
});

test("Codex 0.160.0 exploration opens to each call's transcript, closed from one '− Show less'", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		const rows = [
			bash(harness, "cat README.md", "# Lab\n\nA tiny fixture project.\n"),
			bash(harness, "cat docs/notes.md", "Notes line 1\nNotes line 2\n"),
			bash(harness, "cat src/util.ts", "export const clamp = 1;\n// TODO: add lerp\n"),
		];
		harness.chat.children = rows;
		const click = (label: string) => {
			const lines = harness.chat.render(PI_WIDTH);
			const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
			assert.ok(y >= 0, label);
			const handled = (harness.chat as unknown as { handleMouse(event: object): { handled?: boolean } | undefined })
				.handleMouse({ type: "click", button: "left", x: 6, y, width: PI_WIDTH, height: lines.length });
			assert.equal(handled?.handled, true, label);
		};
		// The opened group in the live reference, its calls one after another with one control beneath them.
		const opened = asPi([
			"$ cat README.md", "# Lab", "", "A tiny fixture project.", "✓ • 0ms", "",
			"$ cat docs/notes.md", "Notes line 1", "Notes line 2", "✓ • 0ms", "",
			"$ cat src/util.ts", "export const clamp = 1;", "// TODO: add lerp", "✓ • 0ms",
			"    − Show less",
		]);
		click("+ Show details");
		assert.deepEqual(drawn(harness.chat.render(PI_WIDTH)), opened, "a click opens it");
		click("− Show less");
		assert.deepEqual(drawn(harness.chat.render(PI_WIDTH)), asPi(["• Explored", "  └ Read README.md, notes.md, util.ts", "    + Show details"]));
		assert.ok(rows.every((row) => !(row as unknown as { expanded: boolean }).expanded), "closing it closes its calls too");
		// Ctrl+O opens every row, and the group with them.
		for (const row of rows) row.setExpanded(true);
		assert.deepEqual(drawn(harness.chat.render(PI_WIDTH)), opened, "Ctrl+O opens it the same way");
		// A call that joins the opened group opens with it, under the one control.
		harness.chat.children = [...rows, bash(harness, "cat five.txt", "1\n2\n3\n4\n5\n")];
		assert.deepEqual(drawn(harness.chat.render(PI_WIDTH)), [
			...opened.slice(0, -1), "", " $ cat five.txt", " 1", " 2", " 3", " 4", " 5", " ✓ • 0ms", opened.at(-1)!,
		]);
	} finally { shutdown(harness); }
});

test("a command that writes or runs something keeps its own row, in Codex's style and Claude's", async () => {
	for (const style of ["codex", "claude"] as const) {
		const harness = await loadExtension({ style }, { tui: true, idle: true });
		try {
			harness.chat.children = [
				bash(harness, "cat README.md", "# Lab"),
				bash(harness, "cat README.md | xargs rm -f", "(no output)"),
				bash(harness, "find . -name '*.log' -delete", "(no output)"),
				bash(harness, "rg ';' src", "src/a.ts:1: ;"),
			];
			const lines = drawn(harness.chat.render(PI_WIDTH)).join("\n");
			for (const command of ["cat README.md | xargs rm -f", "find . -name '*.log' -delete"]) {
				assert.ok(lines.includes(style === "codex" ? `• Ran ${command}` : `Bash(${command})`), `${style}: ${command} is shown\n${lines}`);
			}
			if (style === "codex") assert.ok(lines.includes("Search ; in src"), `a quoted semicolon is a pattern\n${lines}`);
		} finally { shutdown(harness); }
	}
});

test("Codex 0.160.0 exploration reads 'Exploring' while a call runs, with the bullet pulsing", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: false });
	try {
		const id = `codex-running-${++sequence}`;
		announce(harness, id, "bash");
		const row = makeRow("bash", id, { command: "rg -n TODO src" }, harness.definitions.get("bash"));
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "bash", args: {} });
		row.markExecutionStarted();
		harness.chat.children = [row];
		const frames = new Set<string>();
		for (let frame = 0; frame < 8; frame++) {
			const lines = harness.chat.render(PI_WIDTH);
			assert.deepEqual(drawn(lines), asPi(["• Exploring", "  └ Search TODO in src", "    + Show details"]));
			frames.add(lines.find((line) => line.includes("Exploring"))!);
			timerClock.tick(INDICATOR_INTERVAL_MS);
		}
		assert.ok(frames.size > 1, "the bullet pulses");
		harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
		row.updateResult({ ...text("src/a.ts:1: TODO"), isError: false } as never, false);
		assert.equal(drawn(harness.chat.render(PI_WIDTH))[0], " • Explored");
	} finally { shutdown(harness); }
});

test("Codex 0.160.0 commands read 'Running' with the tail of their live output, then 'Ran'", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: false });
	try {
		const id = `codex-live-${++sequence}`;
		const command = "for i in 1 2 3 4 5 6; do echo tick $i; sleep 1; done";
		announce(harness, id, "bash");
		const row = makeRow("bash", id, { command }, harness.definitions.get("bash"));
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "bash", args: {} });
		row.markExecutionStarted();
		assert.deepEqual(drawn(row.render(PI_WIDTH)), [` • Running ${command}`]);
		row.updateResult({ ...text("tick 1\ntick 2"), isError: false } as never, true);
		assert.deepEqual(drawn(row.render(PI_WIDTH)), asPi([`• Running ${command}`, "  └ tick 1", "    tick 2"]));
		row.updateResult({ ...text("tick 1\ntick 2\ntick 3\ntick 4"), isError: false } as never, true);
		assert.deepEqual(drawn(row.render(PI_WIDTH)), asPi([`• Running ${command}`, "  └ tick 2", "    tick 3", "    tick 4", "    + 1 line (ctrl+t to expand)"]));
		harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
		row.updateResult({ ...text("tick 1\ntick 2\ntick 3\ntick 4\ntick 5\ntick 6"), isError: false } as never, false);
		assert.deepEqual(drawn(row.render(PI_WIDTH)), asPi([`• Ran ${command}`, "  └ tick 4", "    tick 5", "    tick 6", "    + 3 lines (ctrl+t to expand)"]));
	} finally { shutdown(harness); }
});

const OLD_FILE = "export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n";
const NEW_FILE = OLD_FILE.replace("Hello", "Hi");
const editResult = () => text("Successfully replaced 1 block(s) in src/app.ts.", {
	diff: generateDiffString(OLD_FILE, NEW_FILE).diff,
	patch: generateUnifiedPatch("src/app.ts", OLD_FILE, NEW_FILE),
});

test("Codex 0.160.0 patches preview their changed lines and open to the whole diff", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		const edit = finished(harness, "edit", { path: "src/app.ts", edits: [{ oldText: "Hello", newText: "Hi" }] }, editResult());
		assert.deepEqual(drawn(edit.render(PI_WIDTH)), asPi([
			"• Edited src/app.ts (+1 -1)", "    2 -    return `Hello, ${name}!`;", "    2 +    return `Hi, ${name}!`;", "    + Show details",
		]));
		edit.setExpanded(true);
		assert.deepEqual(drawn(edit.render(PI_WIDTH)), asPi([
			"• Edited src/app.ts (+1 -1)",
			"    1  export function greet(name: string): string {",
			"    2 -    return `Hello, ${name}!`;",
			"    2 +    return `Hi, ${name}!`;",
			"    3  }",
			"    − Show less",
		]));
		// A changed row is tinted across the whole width, gutter and margin included.
		const tinted = edit.render(PI_WIDTH).filter((line) => /^\x1b\[48;/u.test(line));
		assert.equal(tinted.length, 2);
		for (const line of tinted) assert.equal(visibleWidth(line), PI_WIDTH);
		// Pi does not say whether the file existed, so a write reads "Wrote" where Codex says "Added".
		const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
		const write = finished(harness, "write", { path: "docs/new.md", content }, text("Successfully wrote to docs/new.md"));
		assert.deepEqual(drawn(write.render(PI_WIDTH)), asPi([
			"• Added docs/new.md (+12 -0)", "     1 +line 1", "     2 +line 2", "     3 +line 3", "    + Show details",
		]).map((line) => line.replace("Added", "Wrote")));
		for (const [row, label] of [[edit, "edit"], [write, "write"]] as const) fits(row, label);
	} finally { shutdown(harness); }
});

test("Codex 0.160.0 patches in progress and failed name their file", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: false });
	try {
		const id = `codex-editing-${++sequence}`;
		announce(harness, id, "edit");
		const editing = makeRow("edit", id, { path: "src/app.ts" }, harness.definitions.get("edit"));
		assert.deepEqual(drawn(editing.render(PI_WIDTH)), [" • Editing src/app.ts"]);
		const failed = finished(harness, "edit", { path: "src/app.ts", edits: [] },
			text("Could not find the exact text in src/app.ts. The old text must match exactly including all whitespace and newlines."), true);
		// Codex wraps the reason within the width less its four-column prefix.
		assert.deepEqual(drawn(failed.render(80)), [
			" ✘ Failed to edit src/app.ts",
			"   └ Could not find the exact text in src/app.ts. The old text must match",
			"     exactly including all whitespace and newlines.",
			"     + Show details",
		]);
		fits(failed, "failed edit");
	} finally { shutdown(harness); }
});

test("custom tools read as Codex's MCP calls: the last lines, then the call with its arguments", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		const result = Array.from({ length: 6 }, (_, index) => `result ${index + 1}`).join("\n");
		const called = finished(harness, "web_search", { query: "pi tui", limit: 3 }, text(result));
		assert.deepEqual(drawn(called.render(100)), [" • Called web_search", "   └ result 4", "     result 5", "     result 6", "     + Show details"]);
		called.setExpanded(true);
		assert.deepEqual(drawn(called.render(100)), [
			' • Called web_search({"query":"pi tui","limit":3})',
			...Array.from({ length: 6 }, (_, index) => `${index === 0 ? "   └ " : "     "}result ${index + 1}`),
			"     − Show less",
		]);
		// Too long to sit beside the verb, the call moves beneath it and the result follows four columns in.
		const narrow = drawn(called.render(30));
		assert.deepEqual(narrow.slice(0, 2), [" • Called", '   └ web_search({"query":"pi']);
		assert.equal(narrow[3], "     result 1");
		// A tool's own view of its result, once opened, hangs from "└" like any result, without its opening blank lines.
		const author = { name: "codemode", renderResult: () => ({ render: () => ["", "", "hello from codemode"], invalidate() {} }) };
		const id = `codex-author-${++sequence}`;
		announce(harness, id, "codemode");
		const authored = makeRow("codemode", id, { code: "console.log(1)" }, author);
		authored.updateResult({ ...text("Output:\n\nhello from codemode"), isError: false } as never, false);
		assert.deepEqual(drawn(authored.render(100)), [" • Called codemode", "   └ Output:", "", "     hello from codemode", "     + Show details"]);
		authored.setExpanded(true);
		assert.deepEqual(drawn(authored.render(100)), [' • Called codemode({"code":"console.log(1)"})', "   └ hello from codemode", "     − Show less"]);
		const failed = finished(harness, "web_search", { query: "x" }, text("Search provider unavailable"), true);
		assert.deepEqual(drawn(failed.render(100)), [" • Failed web_search", "   └ Error: Search provider unavailable", "     + Show details"]);
		for (const [row, label] of [[called, "called"], [failed, "failed"]] as const) fits(row, label);
	} finally { shutdown(harness); }
});

test("lone reads, searches, and listings head their rows with Codex's exploration verbs", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		const read = finished(harness, "read", { path: "src/app.ts" }, text(Array.from({ length: 5 }, (_, index) => `line ${index + 1}`).join("\n")));
		assert.deepEqual(drawn(read.render(100)), [" • Read src/app.ts", "   └ line 3", "     line 4", "     line 5", "     + 2 lines (ctrl+o to expand)"]);
		read.setExpanded(true);
		assert.deepEqual(drawn(read.render(100)).slice(-3), [" line 5", " ✓ • 0ms", "     − Show less"]);
		const grep = finished(harness, "grep", { pattern: "TODO", path: "src" }, text("src/a.ts:1: TODO"));
		assert.equal(drawn(grep.render(100))[0], " • Search TODO in src");
		const ls = finished(harness, "ls", {}, text("a.ts"));
		assert.equal(drawn(ls.render(100))[0], " • List .");
		const missing = finished(harness, "read", { path: "gone.ts" }, text("ENOENT: no such file"), true);
		assert.deepEqual(drawn(missing.render(100)), [" • Read gone.ts", "   └ ENOENT: no such file"]);
		for (const [row, label] of [[read, "read"], [grep, "grep"], [missing, "missing"]] as const) fits(row, label);
	} finally { shutdown(harness); }
});

test("Codex bullets are Codex's: green and red once settled, dim on a patch, never Pi's own dot", async () => {
	const harness = await loadExtension({ style: "codex" }, { tui: true, idle: true });
	try {
		const bulletOf = (lines: string[]) => lines.find((line) => line.includes("•"))!;
		const ok = bulletOf(bash(harness, "true", "ok").render(100));
		const bad = bulletOf(bash(harness, "false", "Command exited with code 1", true).render(100));
		const patch = bulletOf(finished(harness, "edit", { path: "src/app.ts", edits: [] }, editResult()).render(100));
		assert.ok(ok.includes(theme.fg("success", "•")), "a command that succeeded");
		assert.ok(bad.includes(theme.fg("error", "•")), "a command that failed");
		assert.ok(patch.includes(theme.fg("dim", "•")), "a patch");
		for (const line of [ok, bad, patch]) assert.ok(!line.includes("⦁"), "never Pi's own dot");
	} finally { shutdown(harness); }
});

test.after(restoreClocks);
