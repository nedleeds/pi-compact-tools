import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	normalizeLineEndings,
} from "../extensions/compact-tools-core.ts";
import { DEFAULT_CONFIG, mergeConfig } from "../extensions/compact-tools-config.ts";
import {
	formatResultLineSummary,
	getArgumentDetails,
	getCallDetails,
} from "../extensions/compact-tools-invocation.ts";
import {
	CachedContainer,
	hardWrapTextWithAnsi,
	limitComponentLines,
	prefixedText,
	styleMultiline,
	wrapEditResult,
} from "../extensions/compact-tools-layout.ts";
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
import type { RowState } from "../extensions/compact-tools-types.ts";

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
	}), "3 lines");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one" }],
	}), "1 line");
	assert.equal(formatResultLineSummary("read", readArgs, {
		content: [{ type: "text", text: "one\ntwo\n\n[8 more lines in file. Use offset=3 to continue.]" }],
	}), "2 lines");
	assert.equal(formatResultLineSummary("grep", { context: 3, limit: 5 }, {
		content: [{ type: "text", text: "match\ncontext\ncontext" }],
	}), "3 lines");
	assert.equal(formatResultLineSummary("bash", {}, {
		content: [{ type: "text", text: "" }],
	}), "0 lines");
	assert.equal(formatResultLineSummary("write", { content: "one\r\ntwo\r\n" }, {
		content: [{ type: "text", text: "ok" }],
	}), "2 lines");
	assert.equal(formatResultLineSummary("edit", {}, {
		content: [{ type: "text", text: "ok" }],
		details: { diff: "-old\n+new" },
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
	assert.equal(edit.preview, false);
	runtime.reset(true);
});

test("classifies pending, running, completed, and failed calls", () => {
	assert.equal(classifyCallStatus(false, false, false), "pending");
	assert.equal(classifyCallStatus(false, true, false), "running");
	assert.equal(classifyCallStatus(false, true, true), "success");
	assert.equal(classifyCallStatus(true, true, true), "error");
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

test("formats concise progress labels for Pi's working row", () => {
	assert.equal(formatToolProgress("read", { path: "src/index.ts" }), "read · src/index.ts");
	assert.equal(formatToolProgress("bash", { command: "npm run check\nnext" }), "bash · npm run check next");
});

test("sweeps a glow across the working label", () => {
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
	const rendered = glowProgressMessage("Glow", 0, theme);
	assert.match(rendered, /^<mdHeading>G<\/mdHeading><text>l<\/text><thinkingMax>o<\/thinkingMax>/);
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
	handlers.get("tool_execution_start")?.({ toolCallId: "1", toolName: "read", args: { path: "a.ts" } });
	handlers.get("tool_execution_end")?.({ toolCallId: "1" });
	handlers.get("agent_end")?.({});
	assert.deepEqual(messages, ["Thinking…", "read · a.ts", "Processing results…", undefined]);
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
	} as Theme;
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
