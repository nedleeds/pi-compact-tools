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
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../extensions/compact-tools-config.ts";
import {
	formatResultLineSummary,
	getArgumentDetails,
	getCallDetails,
	getEditChanges,
	splitReadFooter,
	summarizeShellCommand,
} from "../extensions/compact-tools-invocation.ts";
import {
	CachedContainer,
	hardWrapTextWithAnsi,
	limitComponentLines,
	parseCodeDiff,
	prefixedText,
	renderCodeDiff,
	renderCodeView,
	styleMultiline,
	trimDiffContext,
} from "../extensions/compact-tools-layout.ts";
import { highlightMarkdown } from "../extensions/compact-tools-markdown.ts";
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
import { SUPPORTED_TOOLS, type RowState } from "../extensions/compact-tools-types.ts";

test("normalizes CRLF, LF, and CR line endings", () => {
	assert.equal(normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("formats durations with millisecond precision", () => {
	assert.equal(formatDurationMs(23), "0.023s");
	assert.equal(formatDurationMs(1_039), "1.039s");
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
		"<border> │ </border><toolDiffContext> 8   </toolDiffContext>const before = 1;",
		"<border> │ </border><toolDiffRemoved> 9 - </toolDiffRemoved>const value = old();",
		"<border> │ </border><toolDiffAdded> 9 + </toolDiffAdded>const value = next();",
		"<border> │ </border><toolDiffContext>10   </toolDiffContext>return value;",
	]);
});

test("renders file contents with offset line numbers and a dim continuation notice", () => {
	const rendered = renderCodeView("const a = 1;\n\treturn a;\n", "file.ts", diffTheme, {
		startLine: 99,
		footer: "[Showing lines 99-100 of 300. Use offset=101 to continue.]",
	})?.render(80).map((line) => stripTerminalSequences(line).trimEnd());
	assert.deepEqual(rendered, [
		"<border> │ </border><toolDiffContext> 99  </toolDiffContext>const a = 1;",
		"<border> │ </border><toolDiffContext>100  </toolDiffContext>   return a;",
		"<border> │ </border><dim>[Showing lines 99-100 of 300. Use offset=101 to continue.]</dim>",
	]);
});

test("plain-text files keep the output color instead of guessing a language", () => {
	const rendered = renderCodeView("hello", "NOTES", diffTheme)?.render(120).map(stripTerminalSequences);
	assert.deepEqual(rendered, ["<border> │ </border><toolDiffContext>1  </toolDiffContext><toolOutput>hello</toolOutput>"]);
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
	assert.equal(indicatorTone("running", 0), "borderAccent");
	assert.equal(indicatorTone("running", 7), "borderMuted");
	assert.ok(Array.from(
		{ length: RUNNING_INDICATOR_FRAME_COUNT },
		(_, frame) => indicatorGlyph("running", frame),
	).every((glyph) => glyph === "⦁"));
	assert.equal(indicatorGlyph("success"), "⦁");
	assert.equal(indicatorGlyph("error"), "⦁");
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
		getFgAnsi: (color: string) => color === "borderAccent"
			? "\x1b[38;2;90;100;110m"
			: "\x1b[38;2;20;30;40m",
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
	assert.match(callLines[0]!, /\x1b\[38;2;90;100;110m⦁\x1b\[39m read file\.ts/u);
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

	registered.length = 0;
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.deepEqual(registered, []);

	handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
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
	const rendered = glowProgressMessage("Glow", 2, theme);
	assert.match(rendered, /\x1b\[38;5;\d+mG\x1b\[39m/u);
	assert.doesNotMatch(rendered, /\x1b\[38;2;/u);
});

test("scales a thinking-summary-to-white glow to the working label length", () => {
	const requestedColors: string[] = [];
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		getFgAnsi: (color: string) => {
			requestedColors.push(color);
			return "\x1b[38;2;100;110;120m";
		},
	} as unknown as Theme;
	const short = glowProgressMessage("Glow", 2, theme);
	const long = glowProgressMessage("0123456789abcdef", 8, theme);
	assert.deepEqual(requestedColors, ["thinkingMax", "thinkingMax"]);
	assert.match(short, /^\x1b\[38;2;255;255;255mG\x1b\[39m\x1b\[38;2;178;183;188ml/);
	assert.match(short, /\x1b\[38;2;100;110;120mo\x1b\[39m/);
	const colors = [...long.matchAll(/38;2;(\d+);(\d+);(\d+)m/gu)]
		.map((match) => match.slice(1).map(Number));
	assert.equal(colors.length, 16);
	assert.ok(colors.every((color) =>
		color[0]! >= 100 && color[0]! <= 255
		&& color[1]! >= 110 && color[1]! <= 255
		&& color[2]! >= 120 && color[2]! <= 255));
	assert.ok(colors.some((color) => color[0] === 255 && color[1] === 255 && color[2] === 255));
});

test("keeps one glyph-free Pi working row across thinking and tool progress", () => {
	const handlers = new Map<string, (event: any) => void>();
	const pi = {
		on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const messages: Array<string | undefined> = [];
	let indicator: { frames: string[]; intervalMs?: number } | undefined;
	const theme = { fg: (_color: string, text: string) => text } as Theme;
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
	handlers.get("agent_end")?.({});
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
		"Check the implementation  \n│  \n│ Inspect the renderer.  \n│ Keep the cache.  \n└─ ctrl+t toggle • click to hide",
	);
	assert.equal(renderThinkingView(thinking, "hidden", 80), "Thinking...");
	assert.equal(thinking, "## **Check the implementation**\n\nInspect the renderer.\nKeep the cache.");
});

test("keeps the thinking summary on one visual line", () => {
	const rendered = renderThinkingView("A very long summary that must be truncated", "summary", 16);
	assert.match(rendered.split("\n")[0]!, /^.{1,15}…$/u);
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
