import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	normalizeLineEndings,
} from "../extensions/compact-tools-core.ts";
import { DEFAULT_CONFIG, isFullscreenMode, mergeConfig } from "../extensions/compact-tools-config.ts";
import { classifyToggleInput } from "../extensions/compact-tools-input.ts";
import {
	formatReadResultSummary,
	getArgumentDetails,
	getCallDetails,
} from "../extensions/compact-tools-invocation.ts";
import {
	CachedContainer,
	hardWrapTextWithAnsi,
	prefixedText,
	styleMultiline,
	wrapEditResult,
} from "../extensions/compact-tools-layout.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import { isThinkingStreamEvent, renderThinkingView } from "../extensions/compact-tools-thinking.ts";
import type { RenderContext, RowState } from "../extensions/compact-tools-types.ts";

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
		spinner: { intervalMs: 80 },
	}, "test");
	assert.deepEqual(merged.tools, ["read", "grep"]);
	assert.equal(merged.auto_compact.read, false);
	assert.equal(merged.auto_compact.edit, false);
	assert.equal(merged.spinner.intervalMs, 80);
	assert.equal(DEFAULT_CONFIG.auto_compact.read, true);
	assert.equal(isFullscreenMode(["pi", "--tui-mode=fullscreen"]), true);
	assert.equal(isFullscreenMode(["pi", "--tui-mode", "regular"]), false);
});

test("ignores Ctrl+O key releases while accepting press events", () => {
	assert.equal(classifyToggleInput("\x0f"), "toggle");
	assert.equal(classifyToggleInput("\x1b[111;5u"), "toggle");
	assert.equal(classifyToggleInput("\x1b[111;5:3u"), "release");
	assert.equal(classifyToggleInput("x"), undefined);
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

test("shows read line counts instead of offset and limit", () => {
	const readArgs = { path: "file.ts", offset: 20, limit: 22 };
	assert.equal(getCallDetails("read", readArgs), "file.ts");
	assert.equal(formatReadResultSummary({ content: [{ type: "text", text: "one\ntwo\nthree" }] }), "3 lines");
	assert.equal(formatReadResultSummary({ content: [{ type: "text", text: "one" }] }), "1 line");
	assert.equal(formatReadResultSummary({
		content: [{ type: "text", text: "one\ntwo\n\n[8 more lines in file. Use offset=3 to continue.]" }],
	}), "2 lines");
});

test("keeps invocation metadata visible while separating large result payloads", () => {
	const readArgs = { path: "file.ts", offset: 20, limit: 22 };
	assert.equal(getCallDetails("read", readArgs), "file.ts");
	assert.deepEqual(getArgumentDetails("read", readArgs), {});
	assert.equal(getCallDetails("grep", { path: "src", pattern: "TODO" }), "/TODO/ in src");
	assert.deepEqual(getArgumentDetails("grep", { path: "src", pattern: "TODO", limit: 5 }), { limit: 5 });
	assert.deepEqual(getArgumentDetails("write", { path: "file.ts", content: "large payload" }), {});
});

test("reapplies ANSI styling to every logical line", () => {
	const styled = styleMultiline("first\nsecond", (line) => `\x1b[90m${line}\x1b[39m`);
	assert.deepEqual(styled.split("\n"), ["\x1b[90mfirst\x1b[39m", "\x1b[90msecond\x1b[39m"]);
});

test("keeps result expansion binary and respects per-tool defaults", () => {
	const runtime = new ToolRuntime();
	runtime.configure(DEFAULT_CONFIG, false);
	const read: RowState = {};
	const edit: RowState = {};
	assert.equal(runtime.syncExpansion(read, false, "read"), false);
	assert.equal(runtime.syncExpansion(edit, false, "edit"), true);
	runtime.setResultAvailable(read, "read", true);
	let invalidations = 0;
	runtime.track({ toolCallId: "read-1", invalidate: () => invalidations++ } as RenderContext, "read", read);
	assert.equal(runtime.toggleTrackedRows(), "expanded");
	assert.equal(read.expanded, true);
	assert.equal(runtime.toggleTrackedRows(), "collapsed");
	assert.equal(read.expanded, false);
	assert.equal(invalidations, 2);
	runtime.reset(true);
});

test("classifies pending, running, completed, and failed calls", () => {
	assert.equal(classifyCallStatus(false, false, false), "pending");
	assert.equal(classifyCallStatus(false, true, false), "running");
	assert.equal(classifyCallStatus(false, true, true), "success");
	assert.equal(classifyCallStatus(true, true, true), "error");
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

test("caches wrapped edit processing by width", () => {
	let renders = 0;
	const source: Component = {
		render: () => {
			renders++;
			return ["", "  first", "  second"];
		},
		invalidate() {},
	};
	const theme = { fg: (_color: string, text: string) => text } as Theme;
	const wrapped = wrapEditResult(source, theme);
	const first = wrapped.render(80);
	assert.equal(wrapped.render(80), first);
	assert.equal(renders, 1);
	assert.deepEqual(first, [" │ first", " │ second"]);
	wrapped.render(79);
	assert.equal(renders, 2);
});

test("limits the thinking sweep to active thinking provider events", () => {
	assert.equal(isThinkingStreamEvent("thinking_start"), true);
	assert.equal(isThinkingStreamEvent("thinking_delta"), true);
	assert.equal(isThinkingStreamEvent("thinking_end"), false);
	assert.equal(isThinkingStreamEvent("toolcall_start"), false);
	assert.equal(isThinkingStreamEvent("toolcall_delta"), false);
	assert.equal(isThinkingStreamEvent("done"), false);
});

test("renders the three-state thinking cycle without changing source content", () => {
	const thinking = "## **Check the implementation**\n\nInspect the renderer.\nKeep the cache.";
	assert.equal(
		renderThinkingView(thinking, "summary", 80),
		"Check the implementation  \n└─ ctrl+t toggle • click to hide",
	);
	assert.equal(
		renderThinkingView(thinking, "detail", 80),
		"Check the implementation  \n│  \n│ Inspect the renderer.  \n│ Keep the cache.  \n└─ ctrl+t toggle • click to hide",
	);
	assert.equal(renderThinkingView(thinking, "hidden", 80), "Thinking...");
	assert.equal(thinking, "## **Check the implementation**\n\nInspect the renderer.\nKeep the cache.");
});

test("keeps the thinking summary on one visual line", () => {
	const rendered = renderThinkingView("A very long summary that must be truncated", "summary", 16);
	assert.match(rendered.split("\n")[0]!, /^.{1,15}…  $/u);
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
	assert.ok(rendered.includes("<thinking>Summary</thinking>"));
	assert.ok(rendered.includes("<thinking>Detail heading</thinking>  \n│  \n│ Body"));
	assert.equal(rendered.match(/ctrl\+t toggle/gu)?.length, 2);
	assert.deepEqual(styledSections, [0, 1]);
});
