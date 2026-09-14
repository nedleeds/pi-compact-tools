import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	normalizeLineEndings,
	parseDurationIndicators,
	rgbToAnsi256,
	selectDurationIndicator,
	type DurationIndicatorConfig,
} from "../extensions/compact-tools-core.ts";
import { DEFAULT_CONFIG, isFullscreenMode, mergeConfig } from "../extensions/compact-tools-config.ts";
import { classifyToggleInput } from "../extensions/compact-tools-input.ts";
import {
	formatReadCallDetails,
	getArgumentDetails,
	getCallDetails,
} from "../extensions/compact-tools-invocation.ts";
import { hardWrapTextWithAnsi, prefixedText, styleMultiline } from "../extensions/compact-tools-layout.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import type { RenderContext, RowState } from "../extensions/compact-tools-types.ts";

const indicators: DurationIndicatorConfig[] = [
	{ underMs: 1_000, icon: "fast" },
	{ underMs: 10_000, icon: "medium" },
	{ underMs: 30_000, icon: "slow" },
	{ icon: "fallback" },
];

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

test("caches immutable prefixed layout by terminal width", () => {
	const component = prefixedText("a long line that wraps", " │ ");
	const first = component.render(12);
	assert.equal(component.render(12), first);
	component.invalidate();
	assert.notEqual(component.render(12), first);
});

test("formats read offset and limit inline with the path", () => {
	assert.equal(formatReadCallDetails("file.ts", {}), "file.ts");
	assert.equal(formatReadCallDetails("file.ts", { offset: 20 }), "file.ts (offset: 20)");
	assert.equal(formatReadCallDetails("file.ts", { limit: 22 }), "file.ts (limit: 22)");
	assert.equal(formatReadCallDetails("file.ts", { offset: 20, limit: 22 }), "file.ts (offset: 20, limit: 22)");
});

test("keeps invocation metadata visible while separating large result payloads", () => {
	const readArgs = { path: "file.ts", offset: 20, limit: 22 };
	assert.equal(getCallDetails("read", readArgs), "file.ts (offset: 20, limit: 22)");
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

test("selects duration indicators at exact exclusive boundaries", () => {
	assert.equal(selectDurationIndicator(indicators, undefined)?.icon, "fast");
	assert.equal(selectDurationIndicator(indicators, 999)?.icon, "fast");
	assert.equal(selectDurationIndicator(indicators, 1_000)?.icon, "medium");
	assert.equal(selectDurationIndicator(indicators, 10_000)?.icon, "slow");
	assert.equal(selectDurationIndicator(indicators, 30_000)?.icon, "fallback");
});

test("accepts backwards-compatible icon-only and semantic or hex colors", () => {
	assert.ok(parseDurationIndicators(indicators));
	assert.ok(parseDurationIndicators([
		{ underMs: 1_000, icon: "a", color: "warning" },
		{ icon: "b", color: "#D95C3F" },
	]));
});

test("rejects invalid duration indicator sequences and colors", () => {
	assert.equal(parseDurationIndicators([{ underMs: 1_000, icon: "a" }]), undefined);
	assert.equal(parseDurationIndicators([
		{ underMs: 1_000, icon: "a" },
		{ underMs: 1_000, icon: "b" },
		{ icon: "c" },
	]), undefined);
	assert.equal(parseDurationIndicators([{ icon: "a", color: "#fff" }]), undefined);
	assert.equal(parseDurationIndicators([{ icon: "a", color: "orange" }]), undefined);
});

test("maps RGB colors to ANSI-256 cube or grayscale entries", () => {
	assert.equal(rgbToAnsi256(0, 0, 0), 16);
	assert.equal(rgbToAnsi256(255, 255, 255), 231);
	assert.equal(rgbToAnsi256(128, 128, 128), 244);
	assert.equal(rgbToAnsi256(217, 92, 63), 173);
});
