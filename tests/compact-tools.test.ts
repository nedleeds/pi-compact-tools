import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	indicatorGlyph,
	indicatorStrength,
	indicatorTone,
	normalizeLineEndings,
	RUNNING_INDICATOR_FRAME_COUNT,
} from "../extensions/compact-tools-core.ts";
import { colorizeRgb, fillRgb } from "../extensions/compact-tools-color.ts";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../extensions/compact-tools-config.ts";
import { patchToolRows } from "../extensions/compact-tools-custom.ts";
import { findAnchorTop, ViewportKeeper } from "../extensions/compact-tools-viewport.ts";
import { hookMethod } from "../extensions/compact-tools-hook.ts";
import { languageFromPath, languageFromShebang, resolveLanguage } from "../extensions/compact-tools-language.ts";
import {
	formatResultLineSummary,
	getArgumentDetails,
	getCallDetails,
	getEditChanges,
	splitReadFooter,
	summarizeCustomArguments,
	summarizeFailure,
	summarizeShellCommand,
} from "../extensions/compact-tools-invocation.ts";
import {
	CachedContainer,
	hardWrapTextWithAnsi,
	limitComponentLines,
	parseCodeDiff,
	prefixedText,
	renderArguments,
	renderCodeDiff,
	renderCodeView,
	renderOutput,
	renderToolCall,
	styleMultiline,
	trimDiffContext,
} from "../extensions/compact-tools-layout.ts";
import { highlightMarkdown } from "../extensions/compact-tools-markdown.ts";
import { paintChrome } from "../extensions/compact-tools-palette.ts";
import { formatToolProgress, glowProgressMessage, ProgressController } from "../extensions/compact-tools-progress.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import {
	classifyThinkingToggleInput,
	hasThinkingDetail,
	nextThinkingPhase,
	renderThinkingView,
	thinkingViewForPhase,
	ThinkingCycleController,
	type ThinkingPhase,
} from "../extensions/compact-tools-thinking.ts";
import { SUPPORTED_TOOLS, type BuiltInDefinition, type RowState } from "../extensions/compact-tools-types.ts";

// Tests must never read the developer's real ~/.pi/agent: its settings.json
// (thinking visibility) and compact-tools.json would change what they see.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "compact-tools-agent-"));

test("normalizes CRLF, LF, and CR line endings", () => {
	assert.equal(normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("formats durations with millisecond precision", () => {
	assert.equal(formatDurationMs(23), "0.023s");
	assert.equal(formatDurationMs(1_039), "1.039s");
	assert.equal(formatDurationMs(59_999), "59.999s");
});

test("groups durations of a minute or more like Pi's own shell renderers", () => {
	assert.equal(formatDurationMs(60_000), "1m 0s");
	assert.equal(formatDurationMs(312_481), "5m 12s");
	assert.equal(formatDurationMs(3_599_999), "59m 59s");
	assert.equal(formatDurationMs(3_600_000), "1h 0m 0s");
	assert.equal(formatDurationMs(3_723_400), "1h 2m 3s");
});

test("merges configuration without mutating defaults", () => {
	const merged = mergeConfig(DEFAULT_CONFIG, {
		tools: ["read", "grep"],
		auto_compact: { read: false },
		previewLines: 12,
	}, "test");
	assert.deepEqual(merged.tools, ["read", "grep"]);
	assert.equal(merged.auto_compact.read, false);
	assert.equal(merged.auto_compact.edit, false);
	assert.equal(merged.previewLines, 12);
	assert.equal(mergeConfig(DEFAULT_CONFIG, { previewLines: 0 }, "test").previewLines, 10);
	assert.equal(DEFAULT_CONFIG.auto_compact.read, true);
});

test("summarizes failure diagnostics from file and shell output", () => {
	assert.equal(summarizeFailure("read", "\x1b[31mENOENT: missing file\x1b[0m\nstack frame"), "ENOENT: missing file");
	assert.equal(summarizeFailure("bash", "running tests\nError: missing module\n\nCommand exited with code 1"),
		"Error: missing module (Command exited with code 1)");
	assert.equal(summarizeFailure("bash", "output\n\nCommand timed out after 5 seconds"),
		"Command timed out after 5 seconds");
	assert.equal(summarizeFailure("read", "  \n  "), undefined);
});

test("hard-wraps long ANSI paths into remaining columns instead of moving the path", () => {
	const input = `● read \x1b[90m/var/folders/example-with-a-long-name.png\x1b[39m`;
	const lines = hardWrapTextWithAnsi(input, 16);
	assert.ok(stripTerminalSequences(lines[0]!).startsWith("● read /var/"));
	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => visibleWidth(line) <= 16));
	assert.equal(lines.map(stripTerminalSequences).join(""), stripTerminalSequences(input));
});

test("drops separator whitespace at the start of wrapped command lines", () => {
	const input = `echo \x1b[90mfoo bar\x1b[39m`;
	const lines = hardWrapTextWithAnsi(input, 4).map(stripTerminalSequences);
	assert.deepEqual(lines, ["echo", "foo ", "bar"]);
});

test("caches immutable prefixed layout by terminal width", () => {
	const component = prefixedText("a long line that wraps", " │ ");
	const first = component.render(12);
	assert.equal(component.render(12), first);
	component.invalidate();
	assert.notEqual(component.render(12), first);
});

test("reports completed output lines instead of invocation limits", () => {
	const readArgs = { path: "file.ts", offset: 20, limit: 22 };
	assert.equal(getCallDetails("read", readArgs), "file.ts");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one\ntwo\nthree" }],
		details: undefined,
	}), "3 lines");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one" }],
		details: undefined,
	}), "1 line");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one\ntwo\n\n[8 more lines in file. Use offset=3 to continue.]" }],
		details: undefined,
	}), "2 lines");
	assert.equal(formatResultLineSummary("grep", { context: 3, limit: 5 }, {
		content: [{ type: "text", text: "match\ncontext\ncontext" }],
		details: undefined,
	}), "3 lines");
	assert.equal(formatResultLineSummary("bash", {}, {
		content: [{ type: "text", text: "" }],
		details: undefined,
	}), "0 lines");
	assert.equal(formatResultLineSummary("write", { content: "one\r\ntwo\r\n" }, {
		content: [{ type: "text", text: "ok" }],
		details: undefined,
	}), "2 lines");
	assert.equal(formatResultLineSummary("edit", {}, {
		content: [{ type: "text", text: "ok" }],
		details: { diff: "     ...\n  8 unchanged\n- 9 old\n+ 9 new\n 10 unchanged\n     ..." },
	}), "2 lines");
	assert.equal(formatResultLineSummary("grep", {}, {
		content: [{ type: "text", text: "visible\nfooter" }],
		details: { truncation: { outputLines: 42 } },
	}), "42 lines");
});

test("keeps invocation targets visible while separating large result payloads", () => {
	const readArgs = { path: "file.ts", offset: 20, limit: 22 };
	assert.equal(getCallDetails("read", readArgs), "file.ts");
	assert.deepEqual(getArgumentDetails("read", readArgs), {});
	const grepArgs = { path: "src", pattern: "TODO", glob: "*.ts", context: 3, limit: 5 };
	assert.equal(getCallDetails("grep", grepArgs), "/TODO/ in src");
	const findArgs = { path: "src", pattern: "**/*.test.ts", limit: 20 };
	assert.equal(getCallDetails("find", findArgs), "**/*.test.ts in src");
	assert.equal(getCallDetails("ls", { path: "src", limit: 50 }), "src");
	assert.deepEqual(getArgumentDetails("grep", { path: "src", pattern: "TODO", limit: 5 }), {});
	assert.deepEqual(getArgumentDetails("find", { path: "src", pattern: "*.ts", limit: 5 }), {});
	assert.deepEqual(getArgumentDetails("ls", { path: "src", limit: 5 }), {});
	assert.deepEqual(getArgumentDetails("write", { path: "file.ts", content: "large payload" }), {});
});

test("summarizes collapsed shell calls and shows text-search patterns", () => {
	assert.equal(summarizeShellCommand("bash", "npm run check"), "Run check task");
	assert.equal(summarizeShellCommand("bash", "cd release && git status --short && git log -1"), "Check repository status + 1 more step");
	assert.equal(summarizeShellCommand("bash", "rg very-secret-query src"), 'Search text "very-secret-query"');
	assert.equal(summarizeShellCommand("bash", "rg -n '\\d+ items' src"), 'Search text "\\\\d+ items"');
	assert.equal(summarizeShellCommand("bash", "grep -R --include='*.ts' 'foo bar' ."), 'Search text "foo bar"');
	assert.equal(summarizeShellCommand("bash", "rg --type ts -e 'TODO|FIXME' src"), 'Search text "TODO|FIXME"');
	assert.equal(summarizeShellCommand("powershell", "Select-String -Pattern 'fatal error' -Path *.log"), 'Search text "fatal error"');
	assert.equal(summarizeShellCommand("bash", "find src -name '*.test.ts'"), 'Find files "*.test.ts" in "src"');
	assert.equal(summarizeShellCommand("bash", "fd -e ts controller src tests"), 'Find files "controller" in "src", "tests"');
	assert.equal(summarizeShellCommand("bash", "ls -la src"), 'List files "src"');
	assert.equal(summarizeShellCommand("powershell", "Get-ChildItem -Path C:\\private"), 'List files "C:\\\\private"');
	assert.equal(summarizeShellCommand("bash", "rm -rf build cache"), 'Run rm "build", "cache"');
	assert.equal(summarizeShellCommand("bash", "cp -r src backup/src"), 'Copy "src" to "backup/src"');
	assert.equal(summarizeShellCommand("bash", "custom-tool --token secret"), "Run custom tool");
	assert.equal(summarizeShellCommand("bash", ""), "Prepare shell command");
});

/** A dark theme's neutral ramp plus an accent, so derived chrome colors have room to move. */
const THEME_RAMP_ANSI: Record<string, string> = {
	text: "\x1b[38;2;201;209;217m",
	muted: "\x1b[38;2;139;148;158m",
	dim: "\x1b[38;2;110;118;129m",
	accent: "\x1b[38;2;149;167;255m",
	toolOutput: "\x1b[38;2;152;161;172m",
	thinkingLow: "\x1b[38;2;110;118;129m",
	thinkingMax: "\x1b[38;2;159;207;248m",
};

const DIFF_ANSI: Record<string, string> = {
	text: "\x1b[38;2;201;209;217m",
	toolDiffAdded: "\x1b[38;2;87;166;74m",
	toolDiffRemoved: "\x1b[38;2;229;83;75m",
};

const diffTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	getFgAnsi: (color: string) => DIFF_ANSI[color] ?? "",
	getColorMode: () => "truecolor",
} as unknown as Theme;

test("keeps only changed edit lines for the result line summary", () => {
	const result = {
		content: [{ type: "text" as const, text: "Successfully replaced 1 block" }],
		details: { diff: "     ...\r\n  8 unchanged\r\n- 9 old\r\n+ 9 new\r\n 10 unchanged\r\n     ..." },
	};
	assert.equal(getEditChanges(result), "- 9 old\n+ 9 new");
});

test("renders an edit as a diff with a line-number gutter and tinted change rows", () => {
	const patch = [
		"--- file.ts",
		"+++ file.ts",
		"@@ -8,3 +8,3 @@",
		" const before = 1;",
		"-const value = old();",
		"+const value = next();",
		" return value;",
	].join("\n");
	const rendered = renderCodeDiff(patch, "", "file.ts", diffTheme)?.render(60)
		.map((line) => stripTerminalSequences(line).trimEnd());
	assert.deepEqual(rendered, [
		"<dim> │ </dim><toolDiffContext> 8   </toolDiffContext>const before = 1;",
		"<dim> │ </dim><toolDiffRemoved> 9 - </toolDiffRemoved>const value = old();",
		"<dim> │ </dim><toolDiffAdded> 9 + </toolDiffAdded>const value = next();",
		"<dim> │ </dim><toolDiffContext>10   </toolDiffContext>return value;",
	]);
});

test("renders file contents with offset line numbers and a dim continuation notice", () => {
	const rendered = renderCodeView("const a = 1;\n\treturn a;\n", "file.ts", diffTheme, {
		startLine: 99,
		footer: "[Showing lines 99-100 of 300. Use offset=101 to continue.]",
	})?.render(80).map((line) => stripTerminalSequences(line).trimEnd());
	assert.deepEqual(rendered, [
		"<dim> │ </dim><toolDiffContext> 99  </toolDiffContext>const a = 1;",
		"<dim> │ </dim><toolDiffContext>100  </toolDiffContext>   return a;",
		"<dim> │ </dim><dim>[Showing lines 99-100 of 300. Use offset=101 to continue.]</dim>",
	]);
});

test("plain-text files keep the output color instead of guessing a language", () => {
	const rendered = renderCodeView("hello", "NOTES", diffTheme)?.render(120).map(stripTerminalSequences);
	assert.deepEqual(rendered, ["<dim> │ </dim><toolDiffContext>1  </toolDiffContext><toolOutput>hello</toolOutput>"]);
});

test("highlights Markdown prose and fenced code while keeping every source character", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
		italic: (text: string) => `<i>${text}</i>`,
	} as unknown as Theme;
	const source = [
		"# Title",
		"See `x` and [docs](https://x.dev) with **bold**.",
		"- item",
		"> quote",
		"```",
		"# not a heading",
		"```",
	];
	const rendered = highlightMarkdown(source, theme);
	assert.deepEqual(rendered, [
		"<b><mdHeading># Title</mdHeading></b>",
		"<toolOutput>See </toolOutput><dim>`</dim><mdCode>x</mdCode><dim>`</dim><toolOutput> and </toolOutput>"
			+ "<dim>[</dim><mdLink>docs</mdLink><dim>](</dim><mdLinkUrl>https://x.dev</mdLinkUrl><dim>)</dim>"
			+ "<toolOutput> with </toolOutput><dim>**</dim><b><toolOutput>bold</toolOutput></b><dim>**</dim><toolOutput>.</toolOutput>",
		"<mdListBullet>- </mdListBullet><toolOutput>item</toolOutput>",
		"<mdQuoteBorder>> </mdQuoteBorder><i><mdQuote>quote</mdQuote></i>",
		"<mdCodeBlockBorder>```</mdCodeBlockBorder>",
		"<mdCodeBlock># not a heading</mdCodeBlock>",
		"<mdCodeBlockBorder>```</mdCodeBlockBorder>",
	]);
	assert.deepEqual(rendered.map((line) => line.replace(/<\/?[\w]+>/gu, "")), source);
});

test("highlights a fenced block with its declared language and survives an unclosed fence", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text } as unknown as Theme;
	const rendered = highlightMarkdown(["```ts", "const a = 1;"], theme).map(stripTerminalSequences);
	assert.deepEqual(rendered, ["```ts", "const a = 1;"]);
});

test("separates a read's continuation notice from the file contents", () => {
	assert.deepEqual(splitReadFooter("a\nb\n\n[3 more lines in file. Use offset=3 to continue.]"), {
		body: "a\nb",
		footer: "[3 more lines in file. Use offset=3 to continue.]",
	});
	assert.deepEqual(splitReadFooter("a\n\n[not a footer]"), { body: "a\n\n[not a footer]" });
});

test("drops distant context so a collapsed edit preview still reaches the change", () => {
	const patch = [
		"--- file.ts",
		"+++ file.ts",
		"@@ -1,7 +1,7 @@",
		" one",
		" two",
		" three",
		"-four",
		"+FOUR",
		" five",
		" six",
		" seven",
	].join("\n");
	assert.deepEqual(
		trimDiffContext(parseCodeDiff(patch), 1).map(({ kind, content }) => ({ kind, content })),
		[
			{ kind: "context", content: "three" },
			{ kind: "remove", content: "four" },
			{ kind: "add", content: "FOUR" },
			{ kind: "context", content: "five" },
		],
	);
});

test("parses unified edit patches into numbered code-diff rows", () => {
	const patch = [
		"--- file.ts",
		"+++ file.ts",
		"@@ -8,3 +8,3 @@",
		" keep",
		"-old",
		"+new",
		" tail",
		"@@ -20 +20 @@",
		"-before",
		"+after",
	].join("\n");
	assert.deepEqual(
		parseCodeDiff(patch).map(({ kind, lineNumber, content }) => ({ kind, lineNumber, content })),
		[
			{ kind: "context", lineNumber: 8, content: "keep" },
			{ kind: "remove", lineNumber: 9, content: "old" },
			{ kind: "add", lineNumber: 9, content: "new" },
			{ kind: "context", lineNumber: 10, content: "tail" },
			{ kind: "separator", lineNumber: undefined, content: "⋮" },
			{ kind: "remove", lineNumber: 20, content: "before" },
			{ kind: "add", lineNumber: 20, content: "after" },
		],
	);
});

test("reapplies ANSI styling to every logical line", () => {
	const styled = styleMultiline("first\nsecond", (line) => `\x1b[90m${line}\x1b[39m`);
	assert.deepEqual(styled.split("\n"), ["\x1b[90mfirst\x1b[39m", "\x1b[90msecond\x1b[39m"]);
});

test("uses hidden, preview, and expanded result states with Pi's host toggle", () => {
	const runtime = new ToolRuntime();
	runtime.configure(DEFAULT_CONFIG);
	const read: RowState = {};
	const edit: RowState = {};
	assert.equal(runtime.syncExpansion(read, false, "read"), false);
	assert.equal(read.preview, false);
	assert.equal(runtime.syncExpansion(edit, false, "edit"), false);
	assert.equal(edit.preview, true);
	assert.equal(runtime.syncExpansion(edit, true, "edit"), true);
	assert.equal(edit.preview, false);
	assert.equal(runtime.syncExpansion(edit, false, "edit"), false);
	assert.equal(edit.preview, true);
	assert.equal(runtime.syncExpansion(edit, true, "edit"), true);
	assert.equal(edit.preview, false);
	assert.equal(runtime.syncExpansion(read, true, "read"), true);
	assert.equal(runtime.syncExpansion(read, false, "read"), false);
	assert.equal(read.preview, false);
	runtime.reset(true);
});

test("merges trusted project configuration over the global configuration", () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	const agentDir = mkdtempSync(join(tmpdir(), "compact-tools-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "compact-tools-project-"));
	process.env[agentDirVariable] = agentDir;
	writeFileSync(join(agentDir, "compact-tools.json"), JSON.stringify({ tools: ["read"], previewLines: 5 }));
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "compact-tools.json"), JSON.stringify({ tools: ["edit"], previewLines: 7 }));
	assert.deepEqual(loadConfig(projectDir, false).tools, ["read"]);
	assert.equal(loadConfig(projectDir, false).previewLines, 5);
	assert.deepEqual(loadConfig(projectDir, true).tools, ["edit"]);
	assert.equal(loadConfig(projectDir, true).previewLines, 7);
	if (previousAgentDir === undefined) delete process.env[agentDirVariable];
	else process.env[agentDirVariable] = previousAgentDir;
});

test("forwards Pi's complete execution context through the timing wrapper", async () => {
	const runtime = new ToolRuntime();
	const executionContext = {
		model: { inputLimits: { images: { resize: { maxPixels: 1_000_000 } } } },
	} as unknown as ExtensionContext;
	let received: unknown[] | undefined;
	const definition = {
		async execute(...args: unknown[]) {
			received = args;
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	} as unknown as BuiltInDefinition;
	const signal = new AbortController().signal;
	const onUpdate = () => {};

	await runtime.createTimedExecute(definition)("read-context", { path: "image.png" }, signal, onUpdate, executionContext);
	assert.equal(received?.[0], "read-context");
	assert.equal(received?.[2], signal);
	assert.equal(received?.[3], onUpdate);
	assert.equal(received?.[4], executionContext);
	runtime.reset(true);
});

test("stops the shared indicator timer and keeps parallel tools independent", async () => {
	const runtime = new ToolRuntime();
	let firstInvalidations = 0;
	let secondInvalidations = 0;
	runtime.syncIndicator("first", true, () => firstInvalidations++);
	runtime.syncIndicator("second", true, () => secondInvalidations++);
	await new Promise((resolve) => setTimeout(resolve, 270));
	assert.ok(firstInvalidations > 0);
	assert.ok(secondInvalidations > 0);

	runtime.syncIndicator("first", false, () => {});
	const firstAtCompletion = firstInvalidations;
	const secondBeforeNextFrame = secondInvalidations;
	await new Promise((resolve) => setTimeout(resolve, 270));
	assert.equal(firstInvalidations, firstAtCompletion);
	assert.ok(secondInvalidations > secondBeforeNextFrame);

	runtime.reset(true);
	const secondAtShutdown = secondInvalidations;
	await new Promise((resolve) => setTimeout(resolve, 270));
	assert.equal(secondInvalidations, secondAtShutdown);
});

test("classifies calls and smoothly fades one shared tool indicator glyph", () => {
	assert.equal(classifyCallStatus(false, false, false), "pending");
	assert.equal(classifyCallStatus(false, true, false), "running");
	assert.equal(classifyCallStatus(false, true, true), "success");
	assert.equal(classifyCallStatus(true, true, true), "error");
	assert.equal(indicatorGlyph("pending"), "⦁");
	const strengths = Array.from(
		{ length: RUNNING_INDICATOR_FRAME_COUNT },
		(_, frame) => indicatorStrength("running", frame),
	);
	assert.equal(strengths[0], 1);
	assert.ok(Math.abs(strengths[7]! - 0.08) < 1e-12);
	assert.ok(strengths.slice(0, 8).every((strength, index, values) => index === 0 || strength < values[index - 1]!));
	assert.ok(strengths.slice(7).every((strength, index, values) => index === 0 || strength > values[index - 1]!));
	assert.ok(Math.abs(strengths[1]! - strengths[13]!) < 1e-12);
	assert.equal(indicatorTone("running", 0), "muted");
	assert.equal(indicatorTone("running", 7), "borderMuted");
	assert.ok(Array.from(
		{ length: RUNNING_INDICATOR_FRAME_COUNT },
		(_, frame) => indicatorGlyph("running", frame),
	).every((glyph) => glyph === "⦁"));
	assert.equal(indicatorGlyph("success"), "⦁");
	assert.equal(indicatorGlyph("error"), "⦁");
});

test("frames every rail in one chrome tone, quieter than the theme's own dim", () => {
	const theme = {
		fg: (color: string, text: string) => `${THEME_RAMP_ANSI[color] ?? ""}${text}\x1b[39m`,
		getFgAnsi: (color: string) => THEME_RAMP_ANSI[color] ?? "",
		getColorMode: () => "truecolor",
	} as unknown as Theme;
	const railColor = (line: string) => line.match(/38;2;\d+;\d+;\d+/u)?.[0];
	const chrome = railColor(paintChrome(theme, " │ "));
	const patch = ["@@ -1,2 +1,2 @@", "-const value = old();", "+const value = next();"].join("\n");
	const overflowing: Component = { render: () => ["one", "two"], invalidate() {} };

	// Every surface that draws the frame resolves to the same tone, so a row reads as one object.
	assert.deepEqual([
		railColor(renderToolCall("read", "a path long enough to wrap onto a second line", theme).render(24)[1]!),
		railColor(renderOutput("hello", theme, false)!.render(80)[0]!),
		railColor(renderCodeDiff(patch, "", "a.ts", theme)!.render(80)[0]!),
		railColor(renderCodeView("const a = 1;", "a.ts", theme)!.render(80)[0]!),
		railColor(renderArguments({ path: "a.ts" }, theme).render(80)[0]!),
		railColor(limitComponentLines(overflowing, 1, theme).render(80)[1]!),
	], Array.from({ length: 6 }, () => chrome));

	// The truncation notice rides a chrome rail but reads at the weight of the tool's own
	// arguments, so hidden output stays noticeable without the frame competing with it.
	const truncated = limitComponentLines(overflowing, 1, theme).render(80)[1]!;
	assert.match(stripTerminalSequences(truncated), /^ │ … 1 more line$/u);
	assert.deepEqual([...new Set([...truncated.matchAll(/38;2;\d+;\d+;\d+/gu)].map((match) => match[0]))], [
		chrome,
		THEME_RAMP_ANSI.toolOutput!.match(/38;2;\d+;\d+;\d+/u)![0],
	]);

	// `dim` is the quietest name a theme offers, but it is still sized for body text.
	const luminance = (ansi: string) => {
		const [r, g, b] = ansi.match(/(\d+);(\d+);(\d+)m?$/u)!.slice(1).map(Number);
		return r! * 0.299 + g! * 0.587 + b! * 0.114;
	};
	assert.ok(luminance(chrome!) < luminance(THEME_RAMP_ANSI.dim!));
});

test("limits previews without modifying the full result component", () => {
	const source: Component = {
		render: () => ["one", "two", "three", "four"],
		invalidate() {},
	};
	const theme = { fg: (_color: string, text: string) => text } as Theme;
	assert.deepEqual(limitComponentLines(source, 2, theme).render(80), ["one", "two", " │ … 2 more lines"]);
	assert.deepEqual(source.render(80), ["one", "two", "three", "four"]);
});

test("animates every built-in, restores reload renderers, and reuses unchanged large results", async () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	process.env[agentDirVariable] = mkdtempSync(join(tmpdir(), "compact-tools-test-"));
	writeFileSync(
		join(process.env[agentDirVariable]!, "compact-tools.json"),
		JSON.stringify({ tools: SUPPORTED_TOOLS }),
	);
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const registered: Array<{ name: string; renderCall?: unknown; renderResult?: unknown }> = [];
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
		registerTool: (definition: { name: string; renderCall?: unknown; renderResult?: unknown }) =>
			registered.push(definition),
		registerMarkdownTransformer: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;

	compactTools(pi);
	assert.deepEqual(registered.map(({ name }) => name), [...SUPPORTED_TOOLS]);
	assert.ok(registered.every(({ renderCall, renderResult }) => renderCall && renderResult));

	const renderTheme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		getFgAnsi: (color: string) => THEME_RAMP_ANSI[color] ?? "\x1b[38;2;20;30;40m",
		getColorMode: () => "truecolor",
	} as unknown as Theme;
	const callArguments: Record<string, Record<string, unknown>> = {
		read: { path: "file.ts" },
		write: { path: "file.ts", content: "streaming content" },
		edit: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] },
		bash: { command: "sleep 10" },
		powershell: { command: "Start-Sleep -Seconds 10" },
		grep: { path: "src", pattern: "TODO" },
		find: { path: "src", pattern: "*.ts" },
		ls: { path: "src" },
	};
	for (const definition of registered) {
		const args = callArguments[definition.name]!;
		const renderBuiltInCall = definition.renderCall as (
			args: Record<string, unknown>,
			theme: Theme,
			ctx: any,
		) => Component;
		for (const phase of [
			{ name: "streaming", argsComplete: false, executionStarted: false },
			{ name: "executing", argsComplete: true, executionStarted: true },
		]) {
			const lines = renderBuiltInCall(args, renderTheme, {
				args,
				argsComplete: phase.argsComplete,
				cwd: process.cwd(),
				executionStarted: phase.executionStarted,
				expanded: false,
				invalidate: () => {},
				isError: false,
				isPartial: true,
				lastComponent: undefined,
				showImages: false,
				state: {},
				toolCallId: `${phase.name}-${definition.name}`,
			}).render(80);
			assert.match(
				lines[0]!,
				/\x1b\[38;2;\d+;\d+;\d+m⦁\x1b\[39m/u,
				`${phase.name} ${definition.name}`,
			);
			assert.match(
				stripTerminalSequences(lines[0]!),
				new RegExp(`⦁ ${definition.name}\\b`, "u"),
				`${phase.name} ${definition.name}`,
			);
		}
	}

	const readDefinition = registered.find(({ name }) => name === "read");
	const renderCall = readDefinition?.renderCall as (args: { path: string }, theme: Theme, ctx: any) => Component;
	const renderResult = readDefinition?.renderResult as (
		result: { content: Array<{ type: "text"; text: string }>; details?: unknown },
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		ctx: any,
	) => Component;
	const content = [{
		type: "text" as const,
		text: Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n"),
	}];
	const rowState: RowState = {};
	const resultContext = {
		args: { path: "file.ts" },
		argsComplete: true,
		cwd: process.cwd(),
		executionStarted: true,
		expanded: true,
		invalidate: () => {},
		isError: false,
		isPartial: true,
		lastComponent: undefined,
		showImages: false,
		state: rowState,
		toolCallId: "cached-result",
	};
	const callLines = renderCall({ path: "file.ts" }, renderTheme, resultContext).render(80);
	// Fully lit frame: the indicator sits on the pulse's bright endpoint, derived from `muted`.
	assert.match(callLines[0]!, /\x1b\[38;2;143;147;151m⦁\x1b\[39m read file\.ts/u);
	assert.doesNotMatch(stripTerminalSequences(callLines[0]!), /⦁ {2}read/u);

	const firstResult = renderResult({ content }, { expanded: true, isPartial: true }, renderTheme, resultContext);
	const firstResultText = firstResult.render(80).map(stripTerminalSequences).join("\n");
	assert.doesNotMatch(firstResultText, /ctrl\+o|toggle all|click/iu);
	const reusedResult = renderResult(
		{ content },
		{ expanded: true, isPartial: true },
		renderTheme,
		{ ...resultContext, lastComponent: firstResult },
	);
	assert.equal(reusedResult, firstResult);
	const changedResult = renderResult(
		{ content: [...content] },
		{ expanded: true, isPartial: true },
		renderTheme,
		{ ...resultContext, lastComponent: firstResult },
	);
	assert.notEqual(changedResult, firstResult);

	// The status line belongs to the frame, so it carries the chrome tone and nothing else.
	const finished = renderResult(
		{ content },
		{ expanded: true, isPartial: false },
		renderTheme,
		{ ...resultContext, state: {}, toolCallId: "finished-result", lastComponent: undefined },
	).render(80);
	const controls = finished.at(-1)!;
	assert.match(stripTerminalSequences(controls), /└ Done/u);
	assert.deepEqual([...new Set([...controls.matchAll(/38;2;\d+;\d+;\d+/gu)].map((match) => match[0]))], [
		paintChrome(renderTheme, "x").match(/38;2;\d+;\d+;\d+/u)![0],
	]);

	const failedResult = renderResult(
		{ content: [{ type: "text", text: "ENOENT: missing file\nstack frame" }] },
		{ expanded: false, isPartial: false },
		renderTheme,
		{ ...resultContext, expanded: false, isError: true, state: {}, toolCallId: "failed-read", lastComponent: undefined },
	).render(80).map(stripTerminalSequences).join("\n");
	assert.match(failedResult, /Failed.*ENOENT: missing file/u);
	assert.doesNotMatch(failedResult, /stack frame/u);

	// An edit starts with its preview showing, so the error is already on screen:
	// the status line must not repeat it.
	const editDefinition = registered.find(({ name }) => name === "edit");
	const renderEditResult = editDefinition?.renderResult as typeof renderResult;
	const editError = "Could not find the exact text in file.ts. The old text must match exactly.";
	const failedEdit = renderEditResult(
		{ content: [{ type: "text", text: editError }] },
		{ expanded: false, isPartial: false },
		renderTheme,
		{ ...resultContext, args: { path: "file.ts" }, expanded: false, isError: true, state: {}, toolCallId: "failed-edit", lastComponent: undefined },
	).render(200).map(stripTerminalSequences);
	assert.equal(failedEdit.filter((line) => line.includes("Could not find the exact text")).length, 1, "the error appears once");
	assert.match(failedEdit.at(-1)!, /^ └ Failed( in \S+)?$/u);

	registered.length = 0;
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(registered, []);

	// /reload tears the session down and re-invokes the cached factory, exactly like
	// the session replacements covered below. Firing the events alone would not
	// reproduce that, so drive the factory the way Pi does.
	handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
	compactTools(pi);
	handlers.get("session_start")?.({ reason: "reload" }, ctx);
	assert.deepEqual(registered.map(({ name }) => name), [...SUPPORTED_TOOLS]);
	assert.ok(registered.every(({ renderCall, renderResult }) => renderCall && renderResult));

	registered.length = 0;
	writeFileSync(join(process.env[agentDirVariable]!, "compact-tools.json"), JSON.stringify({ tools: ["read"] }));
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(
		registered.map(({ name }) => name),
		["write", "edit", "bash", "powershell", "grep", "find", "ls", "read"],
	);

	registered.length = 0;
	writeFileSync(join(process.env[agentDirVariable]!, "compact-tools.json"), JSON.stringify({ tools: ["read", "edit"] }));
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(registered.map(({ name }) => name), ["read", "edit"]);

	handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	if (previousAgentDir === undefined) delete process.env[agentDirVariable];
	else process.env[agentDirVariable] = previousAgentDir;
});

test("registers renderers again after every session replacement", async () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	process.env[agentDirVariable] = mkdtempSync(join(tmpdir(), "compact-tools-replace-"));
	writeFileSync(
		join(process.env[agentDirVariable]!, "compact-tools.json"),
		JSON.stringify({ tools: SUPPORTED_TOOLS }),
	);
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;

	// Pi caches the extension factory and re-invokes it with a fresh `pi` whose
	// tool registry starts empty. Each host here stands in for one such invocation.
	const createHost = () => {
		const registered: string[] = [];
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
			registerTool: (definition: { name: string }) => registered.push(definition.name),
			registerMarkdownTransformer: () => {},
		} as unknown as ExtensionAPI;
		return { registered, handlers, pi };
	};

	let host = createHost();
	compactTools(host.pi);
	assert.deepEqual(host.registered, [...SUPPORTED_TOOLS], "startup must install the compact renderers");

	// /resume, /new, and /fork all tear the session down and replace it. Each one
	// must leave the replacement session rendering compactly without a manual /reload.
	for (const reason of ["resume", "new", "fork", "reload"] as const) {
		host.handlers.get("session_shutdown")?.({ reason }, ctx);
		const replacement = createHost();
		compactTools(replacement.pi);
		assert.deepEqual(
			replacement.registered,
			[...SUPPORTED_TOOLS],
			`renderers must be reinstalled after /${reason}`,
		);

		const afterFactory = replacement.registered.length;
		replacement.handlers.get("session_start")?.({ reason }, ctx);
		assert.equal(
			replacement.registered.length,
			afterFactory,
			`session_start after /${reason} must not register the same tools twice`,
		);
		host = replacement;
	}

	host.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	if (previousAgentDir === undefined) delete process.env[agentDirVariable];
	else process.env[agentDirVariable] = previousAgentDir;
});

test("keeps the progress controller inert until it is bound to a TUI", () => {
	const messages: Array<string | undefined> = [];
	const handlers = new Map<string, (event: any) => void>();
	const pi = {
		on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const controller = new ProgressController(pi);

	// Never bound: every handler must be a no-op rather than relying on a
	// downstream guard inside setMessage.
	handlers.get("agent_start")?.({});
	handlers.get("message_update")?.({ assistantMessageEvent: { type: "text_delta" } });
	handlers.get("tool_execution_start")?.({ toolCallId: "1", toolName: "read", args: { path: "a.ts" } });
	handlers.get("tool_execution_end")?.({ toolCallId: "1" });
	handlers.get("agent_settled")?.({});
	assert.equal(messages.length, 0, "an unbound controller must not touch the working row");

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getColorMode: () => "truecolor",
	} as unknown as Theme;
	controller.bind({
		ui: {
			theme,
			setWorkingVisible: () => {},
			setWorkingMessage: (message?: string) => messages.push(message),
			setWorkingIndicator: () => {},
		},
	} as unknown as ExtensionContext);
	handlers.get("agent_start")?.({});
	assert.deepEqual(messages, ["Thinking…"]);

	// Disposed again: later events must not reach the detached context.
	controller.dispose();
	messages.length = 0;
	handlers.get("tool_execution_start")?.({ toolCallId: "2", toolName: "bash", args: { command: "ls" } });
	handlers.get("agent_settled")?.({});
	assert.equal(messages.length, 0, "a disposed controller must not touch the working row");
});

test("uses semantic progress labels without exposing invocation details", () => {
	assert.equal(formatToolProgress("read", { path: "src/index.ts" }), "Reading file…");
	assert.equal(formatToolProgress("bash", { command: "npm run check\nnext" }), "Running command…");
	assert.equal(formatToolProgress("hrbook_search", { query: "secret" }), "Using hrbook search…");
	assert.equal(formatToolProgress("getUserById", {}), "Using get User By Id…");
	assert.equal(
		formatToolProgress("mcp__jira_rca_mcp", { tool: "jira_search", args: { query: "secret" } }),
		"Using jira search…",
	);
	assert.equal(formatToolProgress("mcp", { tool: "hrbook_verify", args: { source: "secret" } }), "Using hrbook verify…");
	assert.equal(formatToolProgress("custom_tool", { tool: "do_not_expose" }), "Using custom tool…");
	assert.equal(formatToolProgress("mcp", { tool: "bad\u001b[31m_name" }), "Using bad name…");
	assert.equal(formatToolProgress("", {}), "Running tool…");
});

test("uses indexed ANSI colors for the glow in 256-color mode", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		getFgAnsi: () => "\x1b[38;5;110m",
		getColorMode: () => "256color",
	} as unknown as Theme;
	const rendered = glowProgressMessage("Glow", 2, theme, "high");
	assert.match(rendered, /\x1b\[38;5;\d+mG\x1b\[39m/u);
	assert.doesNotMatch(rendered, /\x1b\[38;2;/u);
});

test("resolves languages Pi's extension table misses, without guessing", () => {
	// Pi's own mapping still wins where it applies.
	assert.equal(languageFromPath("src/index.ts"), "typescript");
	assert.equal(languageFromPath("a/b/notes.md"), "markdown");

	// Named files that carry no extension.
	assert.equal(languageFromPath("Dockerfile"), "dockerfile");
	assert.equal(languageFromPath("deploy/Containerfile"), "dockerfile");
	assert.equal(languageFromPath("Makefile"), "makefile");
	assert.equal(languageFromPath("CMakeLists.txt"), "cmake");
	assert.equal(languageFromPath("Gemfile"), "ruby");
	assert.equal(languageFromPath("ci/Jenkinsfile"), "groovy");
	assert.equal(languageFromPath("/home/me/.bashrc"), "bash");
	assert.equal(languageFromPath(".editorconfig"), "ini");
	assert.equal(languageFromPath(".env"), "ini");
	assert.equal(languageFromPath(".env.production"), "ini");

	// Extensions Pi does not list.
	assert.equal(languageFromPath("build.mts"), "typescript");
	assert.equal(languageFromPath("tsconfig.jsonc"), "json");
	assert.equal(languageFromPath("run.bat"), "dos");
	assert.equal(languageFromPath("fix.patch"), "diff");
	assert.equal(languageFromPath("logo.svg"), "xml");
	assert.equal(languageFromPath("build.gradle"), "groovy");

	// Case and directory separators must not matter.
	assert.equal(languageFromPath("infra\\DOCKERFILE"), "dockerfile");
	assert.equal(languageFromPath("./Rakefile"), "ruby");

	// Content types that auto-detection reliably gets wrong stay unhighlighted.
	for (const path of ["notes.txt", "server.log", "rows.csv", "data.bin", "LICENSE", "README"]) {
		assert.equal(languageFromPath(path), undefined, path);
	}
});

test("reads the interpreter a shebang declares and ignores anything else", () => {
	assert.equal(languageFromShebang("#!/bin/bash"), "bash");
	assert.equal(languageFromShebang("#!/usr/bin/env python3"), "python");
	assert.equal(languageFromShebang("#!/usr/bin/env -S node --enable-source-maps"), "javascript");
	assert.equal(languageFromShebang("#!/usr/bin/ruby2.7"), "ruby");
	assert.equal(languageFromShebang("#! /usr/bin/env  deno"), "typescript");
	assert.equal(languageFromShebang("#!/usr/bin/env FOO=1 perl"), "perl");

	assert.equal(languageFromShebang("#!/usr/bin/env unknown-thing"), undefined);
	assert.equal(languageFromShebang("# not a shebang"), undefined);
	assert.equal(languageFromShebang("const x = 1;"), undefined);
	assert.equal(languageFromShebang(""), undefined);
});

test("prefers the path over a shebang and only consults a real first line", () => {
	// An extension Pi already knows wins over the interpreter line.
	assert.equal(resolveLanguage("script.py", "#!/bin/bash"), "python");
	// Extensionless script: the shebang is the only declaration available.
	assert.equal(resolveLanguage("bin/release", "#!/usr/bin/env bash"), "bash");
	// No first line supplied (a diff hunk, or a read starting past line 1).
	assert.equal(resolveLanguage("bin/release"), undefined);
	assert.equal(resolveLanguage("bin/release", "  echo hello"), undefined);
});

test("memoized 256-color conversion matches an independent nearest-color search", () => {
	const theme = { getColorMode: () => "256color" } as unknown as Theme;
	const channel = (part: number) => (part === 0 ? 0 : 55 + part * 40);
	const basic = [
		[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128],
		[192, 192, 192], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255],
		[255, 0, 255], [0, 255, 255], [255, 255, 255],
	];
	const nearest = (r: number, g: number, b: number) => {
		let best = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let index = 0; index < 256; index++) {
			let candidate: number[];
			if (index < 16) candidate = basic[index]!;
			else if (index < 232) {
				const value = index - 16;
				candidate = [channel(Math.floor(value / 36)), channel(Math.floor((value % 36) / 6)), channel(value % 6)];
			} else {
				const gray = 8 + Math.min(23, index - 232) * 10;
				candidate = [gray, gray, gray];
			}
			const distance = (r - candidate[0]!) ** 2 + (g - candidate[1]!) ** 2 + (b - candidate[2]!) ** 2;
			if (distance >= bestDistance) continue;
			best = index;
			bestDistance = distance;
		}
		return String(best);
	};
	const indexOf = (rendered: string) => rendered.match(/\d+;5;(\d+)m/u)?.[1];
	for (let r = 0; r < 256; r += 37) {
		for (let g = 0; g < 256; g += 41) {
			for (let b = 0; b < 256; b += 43) {
				const expected = nearest(r, g, b);
				const rgb = { r, g, b };
				assert.equal(indexOf(colorizeRgb(theme, rgb, "x")), expected, `fg rgb(${r},${g},${b})`);
				// Second call must come from the memo and agree with the cold result.
				assert.equal(indexOf(colorizeRgb(theme, rgb, "x")), expected, `memoized fg rgb(${r},${g},${b})`);
				assert.equal(indexOf(fillRgb(theme, rgb, "x")), expected, `bg rgb(${r},${g},${b})`);
			}
		}
	}
	assert.match(colorizeRgb(theme, { r: 10, g: 20, b: 30 }, "x"), /^\x1b\[38;5;\d+mx\x1b\[39m$/u);
	assert.match(fillRgb(theme, { r: 10, g: 20, b: 30 }, "x"), /^\x1b\[48;5;\d+mx\x1b\[49m$/u);
});

test("scales the working-label glow to its length and follows the theme's background", () => {
	const requestedColors: string[] = [];
	const rampTheme = (ansi: Record<string, string>) => ({
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		getFgAnsi: (color: string) => {
			requestedColors.push(color);
			return ansi[color] ?? "";
		},
	}) as unknown as Theme;
	const luminance = (color: number[]) => color[0]! * 0.299 + color[1]! * 0.587 + color[2]! * 0.114;
	const glowColors = (rendered: string) =>
		[...rendered.matchAll(/38;2;(\d+);(\d+);(\d+)m/gu)].map((match) => match.slice(1).map(Number));

	const dark = rampTheme(THEME_RAMP_ANSI);
	const short = glowProgressMessage("Glow", 2, dark, "max");
	const long = glowProgressMessage("0123456789abcdef", 8, dark, "max");
	// The sweep is built from the theme's color for the active thinking level, never a fixed white.
	assert.deepEqual([...new Set(requestedColors)].sort(), ["text", "thinkingMax"]);
	const shortColors = glowColors(short);
	const longColors = glowColors(long);
	assert.equal(shortColors.length, 4);
	assert.equal(longColors.length, 16);
	// The highlight is a single peak that rides the frame, and the radius grows with length.
	const peak = (colors: number[][]) => colors.reduce(
		(best, color, index) => luminance(color) > luminance(colors[best]!) ? index : best,
		0,
	);
	assert.equal(peak(shortColors), 0);
	assert.equal(peak(longColors), 4);
	const lit = (colors: number[][]) => colors.filter((color) => luminance(color) > luminance(colors.at(-1)!)).length;
	assert.ok(lit(longColors) > lit(shortColors));
	// On a dark theme the highlight brightens, and it stays inside the derived endpoints.
	assert.ok(longColors.every((color) => luminance(color) >= luminance(longColors.at(-1)!) - 1));
	assert.ok(luminance(longColors[4]!) > luminance(longColors.at(-1)!));

	requestedColors.length = 0;
	const light = rampTheme({
		text: "\x1b[38;2;31;35;40m",
		muted: "\x1b[38;2;108;108;108m",
		dim: "\x1b[38;2;118;118;118m",
		thinkingMax: "\x1b[38;2;175;0;95m",
	});
	// A light background inverts the sweep: the highlight has to darken to stay readable.
	const onLight = glowColors(glowProgressMessage("0123456789abcdef", 8, light, "max"));
	assert.equal(onLight.length, 16);
	assert.ok(luminance(onLight[4]!) < luminance(onLight.at(-1)!));
	assert.ok(onLight.every((color) => luminance(color) <= luminance(onLight.at(-1)!) + 1));
});

test("survives a theme that paints a level black or does not know it at all", () => {
	const theme = {
		fg: (color: string, text: string) => {
			// Pi throws from fg() too, so a fallback must never name the color that just failed.
			if (!THEME_RAMP_ANSI[color] && color !== "text" && color !== "muted") {
				throw new Error(`Unknown theme color: ${color}`);
			}
			return `<${color}>${text}</${color}>`;
		},
		getFgAnsi: (color: string) => {
			if (color === "thinkingOff") return "\x1b[38;2;0;0;0m";
			if (color === "thinkingMax") throw new Error("Unknown theme color: thinkingMax");
			return THEME_RAMP_ANSI[color] ?? "";
		},
		getColorMode: () => "truecolor",
	} as unknown as Theme;

	// Pure black carries no ratio to scale, so the floor has to produce it from the poles.
	const channels = [...glowProgressMessage("Working", 0, theme, "off").matchAll(/38;2;(\d+);(\d+);(\d+)/gu)]
		.flatMap((match) => match.slice(1).map(Number));
	assert.ok(channels.length > 0);
	assert.ok(channels.every((value) => Number.isFinite(value) && value >= 0 && value <= 255));
	assert.ok(channels.some((value) => value > 60), "a level painted black must still be readable");

	// An unresolvable color falls back to names every theme carries, without rethrowing.
	assert.match(glowProgressMessage("Working", 0, theme, "max"), /<muted>|<text>/u);
});

test("repaints the working label in the session's thinking level", () => {
	const handlers = new Map<string, (event: any) => void>();
	const pi = {
		on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
		getThinkingLevel: () => "low",
	} as unknown as ExtensionAPI;
	const messages: Array<string | undefined> = [];
	const theme = {
		fg: (color: string, text: string) => `${THEME_RAMP_ANSI[color] ?? ""}${text}\x1b[39m`,
		getFgAnsi: (color: string) => THEME_RAMP_ANSI[color] ?? "",
		getColorMode: () => "truecolor",
	} as unknown as Theme;
	const controller = new ProgressController(pi);
	controller.bind({
		ui: {
			theme,
			setWorkingVisible: () => {},
			setWorkingMessage: (message?: string) => messages.push(message),
			setWorkingIndicator: () => {},
		},
	} as unknown as ExtensionContext);

	const crest = (label: string) => label.match(/38;2;(\d+);(\d+);(\d+)/u)![0];
	handlers.get("agent_start")?.({});
	const atLow = crest(messages.at(-1)!);

	// A level change recolors the label in place, without restarting the sweep.
	handlers.get("thinking_level_select")?.({ level: "max", previousLevel: "low" });
	const atMax = crest(messages.at(-1)!);
	assert.notEqual(atMax, atLow);
	assert.equal(stripTerminalSequences(messages.at(-1)!), "Thinking…");

	// The same level again is not a change, so nothing is repainted.
	const before = messages.length;
	handlers.get("thinking_level_select")?.({ level: "max", previousLevel: "max" });
	assert.equal(messages.length, before);
	controller.dispose();
});

test("keeps one glyph-free Pi working row across thinking and tool progress", () => {
	const handlers = new Map<string, (event: any) => void>();
	const pi = {
		on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const messages: Array<string | undefined> = [];
	let indicator: { frames: string[]; intervalMs?: number } | undefined;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
	const controller = new ProgressController(pi);
	controller.bind({
		ui: {
			theme,
			setWorkingVisible: () => {},
			setWorkingMessage: (message?: string) => messages.push(message),
			setWorkingIndicator: (value?: typeof indicator) => { indicator = value; },
		},
	} as unknown as ExtensionContext);
	assert.deepEqual(indicator?.frames, []);
	handlers.get("agent_start")?.({});
	handlers.get("message_update")?.({ assistantMessageEvent: { type: "thinking_delta" } });
	handlers.get("message_update")?.({ assistantMessageEvent: { type: "thinking_delta" } });
	handlers.get("tool_execution_start")?.({ toolCallId: "1", toolName: "read", args: { path: "a.ts" } });
	handlers.get("tool_execution_end")?.({ toolCallId: "1" });
	const beforeAgentEnd = messages.length;
	handlers.get("agent_end")?.({});
	assert.equal(messages.length, beforeAgentEnd, "a low-level run may still retry or continue");
	handlers.get("agent_settled")?.({});
	assert.deepEqual(messages, ["Thinking…", "Reading file…", "Processing results…", undefined]);
	controller.dispose();
});

test("caches expanded container lines by width", () => {
	let renders = 0;
	const child: Component = {
		render: (width) => {
			renders++;
			return ["x".repeat(width)];
		},
		invalidate() {},
	};
	const container = new CachedContainer();
	container.addChild(child);
	const first = container.render(80);
	assert.equal(container.render(80), first);
	assert.equal(renders, 1);
	container.render(79);
	assert.equal(renders, 2);
	container.invalidate();
	container.render(79);
	assert.equal(renders, 3);
});

test("cycles summary, detail, summary, and hidden in order", () => {
	let phase: ThinkingPhase = "summary";
	const views = [];
	for (let index = 0; index < 4; index++) {
		phase = nextThinkingPhase(phase);
		views.push(thinkingViewForPhase(phase));
	}
	assert.deepEqual(views, ["detail", "summary", "hidden", "summary"]);
});

test("ignores Ctrl+T repeat and release events on Kitty terminals", () => {
	assert.equal(classifyThinkingToggleInput("\x14"), "toggle");
	assert.equal(classifyThinkingToggleInput("\x1b[116;5u"), "toggle");
	assert.equal(classifyThinkingToggleInput("\x1b[116;5:2u"), "repeat");
	assert.equal(classifyThinkingToggleInput("\x1b[116;5:3u"), "release");
	assert.equal(classifyThinkingToggleInput("x"), undefined);
});

test("leaves Ctrl+T to Pi's visibility toggle when thinking has no detail", () => {
	let transform: ((markdown: string, context: any) => string) | undefined;
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const pi = {
		on: () => {},
		registerMarkdownTransformer: (handler: typeof transform) => {
			transform = handler;
		},
	} as unknown as ExtensionAPI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		getFgAnsi: () => "",
	} as unknown as Theme;
	const controller = new ThinkingCycleController(pi);
	controller.bind({
		ui: {
			theme,
			setHiddenThinkingLabel: () => {},
			onTerminalInput: (handler: typeof terminalInput) => {
				terminalInput = handler;
				return () => {};
			},
		},
	} as unknown as ExtensionContext);
	const render = () => transform?.("**Planning integration harness testing**", {
		messageType: "assistant-thinking",
		isStreaming: false,
		availableWidth: 80,
	});

	assert.equal(render(), "Planning integration harness testing");
	assert.equal(terminalInput?.("\x14"), undefined);
	assert.equal(render(), "Planning integration harness testing");
	assert.equal(terminalInput?.("\x14"), undefined);
	controller.dispose();
});

test("detects whether provider thinking includes expandable detail", () => {
	assert.equal(hasThinkingDetail("Planning integration harness testing"), false);
	assert.equal(hasThinkingDetail("Summary\n\nDetailed reasoning"), true);
	assert.equal(hasThinkingDetail("Summary\n**Another summary**"), false);
});

test("renders each thinking view without changing source content", () => {
	const thinking = "## **Check the implementation**\n\nInspect the renderer.\nKeep the cache.";
	assert.equal(renderThinkingView(thinking, "summary", 80), "Check the implementation");
	assert.equal(
		renderThinkingView(thinking, "detail", 80),
		"Check the implementation  \n│  \n│ Inspect the renderer.  \n│ Keep the cache.  \n└ ctrl+t toggle • click to hide",
	);
	assert.equal(renderThinkingView(thinking, "hidden", 80), "Thinking...");
	assert.equal(thinking, "## **Check the implementation**\n\nInspect the renderer.\nKeep the cache.");
});

test("shows the whole thinking summary instead of truncating it", () => {
	const paragraph = "I need to check the config loader first because project settings are ignored when untrusted.";
	for (const view of ["summary", "detail"] as const) {
		const rendered = renderThinkingView(paragraph, view, 16);
		assert.ok(rendered.includes(paragraph), view);
		assert.ok(!rendered.includes("…"), view);
	}
});

test("renders a connected detail rail while preserving fenced code", () => {
	const rendered = renderThinkingView(
		"Summary\n**Emphasis** and `code`.\n\n```js\nconst value = 1;\n```",
		"detail",
		80,
	);
	assert.ok(rendered.includes("│ **Emphasis** and `code`.  "));
	assert.ok(rendered.includes("> ```js\n> const value = 1;\n> ```"));
});

test("splits headings into independently styled thinking sections", () => {
	const styledSections: number[] = [];
	const rendered = renderThinkingView("Summary\n**Detail heading**\nBody", "detail", 80, {
		styleSummary: (summary, sectionIndex) => {
			styledSections.push(sectionIndex);
			return `<thinking>${summary}</thinking>`;
		},
	});
	assert.ok(rendered.includes("<thinking>Summary</thinking>\n\n<thinking>Detail heading</thinking>"));
	assert.ok(rendered.includes("<thinking>Detail heading</thinking>  \n│  \n│ Body"));
	assert.equal(rendered.match(/ctrl\+t toggle/gu)?.length, 1);
	assert.deepEqual(styledSections, [0, 1]);
});

test("summarizes custom tool arguments on one line", () => {
	assert.equal(summarizeCustomArguments({ numResults: 10, queries: ["IREN news", "IREN earnings"] }), "IREN news, IREN earnings");
	assert.equal(summarizeCustomArguments({ mode: "readable", url: "https://example.com" }), "https://example.com");
	assert.equal(summarizeCustomArguments({ note: "first\nsecond" }), "first second");
	assert.equal(summarizeCustomArguments({ options: { deep: true } }), "");
	assert.equal(summarizeCustomArguments({ query: "x".repeat(400) }).length, 160);
});

test("parses custom_tools as a switch or a policy object", () => {
	assert.deepEqual(DEFAULT_CONFIG.custom_tools, { enabled: true, auto_compact: true, exclude: [] });
	assert.equal(mergeConfig(DEFAULT_CONFIG, { custom_tools: false }, "test").custom_tools.enabled, false);
	const merged = mergeConfig(DEFAULT_CONFIG, { custom_tools: { auto_compact: false, exclude: ["web_search"] } }, "test");
	assert.deepEqual(merged.custom_tools, { enabled: true, auto_compact: false, exclude: ["web_search"] });
	assert.deepEqual(mergeConfig(merged, { custom_tools: { exclude: "web_search" } }, "test").custom_tools.exclude, ["web_search"]);
	assert.equal(mergeConfig(merged, { custom_tools: "yes" }, "test").custom_tools.auto_compact, false);
});

class FakeToolRow {
	constructor(
		readonly toolName: string,
		readonly toolDefinition?: { renderCall?: unknown; renderResult?: unknown; renderShell?: "default" | "self" },
	) {}
	getCallRenderer(): unknown {
		return this.toolDefinition?.renderCall;
	}
	getResultRenderer(): unknown {
		return this.toolDefinition?.renderResult;
	}
	getRenderShell(): string {
		return this.toolDefinition?.renderShell ?? "default";
	}
	hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}
}

test("routes tool rows through the resolver once per row", () => {
	class Row extends FakeToolRow {}
	const resolverKey = Symbol.for("pi-compact-tools.custom.resolver");
	const holder = globalThis as Record<symbol, unknown>;
	const previous = holder[resolverKey];
	let calls = 0;
	const renderers = { renderCall: () => undefined, renderResult: () => undefined };
	holder[resolverKey] = (row: FakeToolRow) => {
		calls++;
		return row.toolName === "custom" ? renderers : undefined;
	};
	try {
		assert.equal(patchToolRows(Row.prototype), true);
		assert.equal(patchToolRows(Row.prototype), true);
		const custom = new Row("custom");
		assert.equal(custom.hasRendererDefinition(), true);
		assert.equal(custom.getRenderShell(), "self");
		assert.equal(custom.getCallRenderer(), renderers.renderCall);
		assert.equal(custom.getResultRenderer(), renderers.renderResult);
		const own = () => undefined;
		const other = new Row("other", { renderCall: own });
		assert.equal(other.getCallRenderer(), own);
		assert.equal(other.getRenderShell(), "default");
		assert.equal(new Row("other").hasRendererDefinition(), false);
		// One decision per row, however often Pi asks.
		assert.equal(calls, 3);
		holder[resolverKey] = () => undefined;
		assert.equal(custom.getRenderShell(), "self", "a built row never switches renderers");
		assert.equal(patchToolRows(undefined), false);
		assert.equal(patchToolRows({ getCallRenderer() {} }), false);
	} finally {
		holder[resolverKey] = previous;
	}
});

test("renders custom tools compactly and expands into the author's renderer", async () => {
	const agentDirVariable = "PI_CODING_AGENT_DIR";
	const previousAgentDir = process.env[agentDirVariable];
	process.env[agentDirVariable] = mkdtempSync(join(tmpdir(), "compact-tools-custom-"));
	writeFileSync(
		join(process.env[agentDirVariable]!, "compact-tools.json"),
		JSON.stringify({ custom_tools: { exclude: ["keep_me"] } }),
	);
	try {
		const compactTools = (await import("../extensions/compact-tools.ts")).default;
		compactTools({
			on: () => {},
			registerTool: () => {},
			registerMarkdownTransformer: () => {},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		class Row extends FakeToolRow {}
		assert.equal(patchToolRows(Row.prototype), true);

		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
			getFgAnsi: () => "\x1b[38;2;20;30;40m",
			getColorMode: () => "truecolor",
		} as unknown as Theme;
		const authorState = { author: true };
		const authorCalls: Array<{ expanded: boolean; state: unknown }> = [];
		const renderAuthorResult = (_result: unknown, options: { expanded: boolean }, _theme: Theme, ctx: any) => {
			authorCalls.push({ expanded: options.expanded, state: ctx.state });
			return { render: () => ["AUTHOR CARD"], invalidate: () => {} };
		};
		const row = new Row("web_search", { renderResult: renderAuthorResult, renderShell: "default" });
		assert.equal(row.getRenderShell(), "self");
		const args = { queries: ["IREN news"], numResults: 10 };
		const context = (expanded: boolean) => ({
			args,
			argsComplete: true,
			cwd: process.cwd(),
			executionStarted: true,
			expanded,
			invalidate: () => {},
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			showImages: false,
			state: authorState,
			toolCallId: `custom-${expanded}`,
		});
		const renderCall = row.getCallRenderer() as (args: unknown, theme: Theme, ctx: unknown) => Component;
		const renderResult = row.getResultRenderer() as (
			result: unknown,
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			ctx: unknown,
		) => Component;
		const call = renderCall(args, theme, context(false)).render(80).map((line) => stripTerminalSequences(line));
		assert.match(call[0]!, /⦁ web_search IREN news$/u);
		const result = { content: [{ type: "text", text: "one\ntwo" }] };

		const collapsed = renderResult(result, { expanded: false, isPartial: false }, theme, context(false))
			.render(80).map((line) => stripTerminalSequences(line));
		assert.equal(collapsed.length, 1);
		assert.match(collapsed[0]!, /^ └ Done.*\(2 lines\)$/u);
		assert.equal(authorCalls.length, 0, "a collapsed row does not ask the author to render");

		const expanded = renderResult(result, { expanded: true, isPartial: false }, theme, context(true))
			.render(80).map((line) => stripTerminalSequences(line));
		assert.deepEqual(expanded.slice(0, 1), [" │ AUTHOR CARD"]);
		assert.deepEqual(authorCalls, [{ expanded: true, state: authorState }]);
		assert.deepEqual(authorState, { author: true }, "compact bookkeeping stays out of the author's state");

		const kept = () => undefined;
		assert.equal(new Row("keep_me", { renderCall: kept }).getCallRenderer(), kept);
		assert.equal(new Row("read", { renderCall: kept }).getCallRenderer(), kept);
	} finally {
		if (previousAgentDir === undefined) delete process.env[agentDirVariable];
		else process.env[agentDirVariable] = previousAgentDir;
	}
});

test("finds where the reader's text moved after rows above it resized", () => {
	const before = ["a1", "a2", "TOOL", "", "b1", "b2", "b3", "c1"];
	// A row above the viewport expanded by three lines.
	const expanded = ["a1", "a2", "TOOL", "x", "y", "z", "", "b1", "b2", "b3", "c1"];
	assert.equal(findAnchorTop(before, 4, 3, expanded), 7);
	// Collapsing it again brings the same text back to its old offset.
	assert.equal(findAnchorTop(expanded, 7, 3, before), 4);
	// When the top line vanished (a hidden tool row), the next surviving text keeps its screen row.
	const hidden = ["a1", "a2", "", "b1", "b2", "b3", "c1"];
	assert.equal(findAnchorTop(["a1", "a2", "TOOL", "DONE", "b1", "b2"], 2, 4, hidden), 1);
	// Blank windows never anchor, and nothing surviving yields no move.
	assert.equal(findAnchorTop(["", "", "q"], 0, 2, ["", "", ""]), undefined);
	// A repeated window picks the occurrence nearest the old position.
	assert.equal(findAnchorTop(["r", "s", "r", "s", "t"], 2, 2, ["n", "r", "s", "r", "s", "t"]), 3);
});

test("keeps the reader's place across a relayout key and ignores a view that follows the end", async () => {
	const { TuiAltScreen } = await import("@earendil-works/pi-tui");
	let content = ["a1", "a2", "TOOL", "", "b1", "b2", "b3", "c1", "c2", "c3"];
	const scrollView = {
		scrollTop: 4,
		isFollowingEnd: false,
		viewportHeight: 3,
		child: { render: () => content },
		getContentWidth: (width: number) => width,
		updateLayout(height: number) { this.height = height; },
		height: content.length,
		scrollTo(top: number) { this.scrollTop = top; },
	};
	const layout = () => ({ root: { children: [{ scrollView, scrollContentLines: content, rect: { width: 40 }, children: [] }] } });
	// Extensions only see a proxy to Pi's current renderer, so the restore hooks the
	// fullscreen renderer's class. Its real doRender returns at once for a renderer
	// that is not on the alternate screen, like this stand-in.
	const tui = {
		terminal: { columns: 40 },
		currentLayout: layout(),
		getPrimaryScrollView: () => scrollView,
	};
	const render = () => (TuiAltScreen.prototype as unknown as { doRender(): void }).doRender.call(tui);
	let input: ((data: string) => unknown) | undefined;
	const ctx = {
		ui: {
			setWidget: (_key: string, factory: unknown) => {
				if (typeof factory === "function") factory(tui, {});
			},
			onTerminalInput: (handler: (data: string) => unknown) => {
				input = handler;
				return () => { input = undefined; };
			},
		},
	} as unknown as ExtensionContext;
	const keeper = new ViewportKeeper();
	keeper.bind(ctx);
	assert.equal(input!("\x0f"), undefined, "the key is observed, never consumed");
	// Pi expands every row: three lines appear above the viewport.
	content = ["a1", "a2", "TOOL", "x", "y", "z", "", "b1", "b2", "b3", "c1", "c2", "c3"];
	render();
	assert.equal(scrollView.scrollTop, 7, "b1 stays on the first screen row");

	// The Kitty release of the same key must not snapshot again: the reader's next
	// scroll would otherwise be pulled back to the old place.
	tui.currentLayout = layout();
	input!("\x1b[111;5:3u");
	scrollView.scrollTop = 2;
	render();
	assert.equal(scrollView.scrollTop, 2, "a released key leaves the reader's scroll alone");

	// Nor may a snapshot undo a scroll that happened before the relayout was drawn.
	scrollView.scrollTop = 7;
	tui.currentLayout = layout();
	input!("\x0f");
	scrollView.scrollTop = 5;
	content = ["a1"];
	render();
	assert.equal(scrollView.scrollTop, 5);

	// Following the end needs no help, so nothing is captured.
	scrollView.isFollowingEnd = true;
	input!("\x0f");
	render();
	assert.equal(scrollView.scrollTop, 5);
	keeper.dispose();
	assert.equal(input, undefined);
});

test("hooks a method once and lets every later load replace only its behavior", () => {
	const legacy = Symbol.for("pi-compact-tools.test.legacyRender");
	class Box {
		render(width: number): string[] {
			return [`box ${width}`];
		}
	}
	// An older version wrapped render and kept the original under its own marker.
	const original = Box.prototype.render;
	Box.prototype.render = function (width: number) {
		return ["OLD", ...original.call(this, width)];
	};
	Object.defineProperty(Box.prototype, legacy, { value: original });
	const name = `test.box.${Math.random()}`;
	assert.equal(hookMethod(Box.prototype, "render", name, (_self, args, render) => ["v1", ...render(...args)], [legacy]), true);
	assert.deepEqual(new Box().render(5), ["v1", "box 5"], "the legacy wrapper is dropped, not stacked");
	// A /reload loads the module again: the same hook now runs the new behavior.
	const wrapper = Box.prototype.render;
	assert.equal(hookMethod(Box.prototype, "render", name, (_self, args, render) => ["v2", ...render(...args)], [legacy]), true);
	assert.equal(Box.prototype.render, wrapper, "installed once per process");
	assert.deepEqual(new Box().render(7), ["v2", "box 7"]);
	assert.equal(hookMethod({}, "render", `${name}.missing`, () => []), false);
});
