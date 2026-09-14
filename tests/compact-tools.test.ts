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
	shouldExpandAll,
	type DurationIndicatorConfig,
} from "../extensions/compact-tools-core.ts";
import {
	classifyToggleInput,
	formatReadCallDetails,
	getBinaryOutputLevels,
	hardWrapTextWithAnsi,
	styleMultiline,
} from "../extensions/compact-tools.ts";

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

test("formats read offset and limit inline with the path", () => {
	assert.equal(formatReadCallDetails("file.ts", {}), "file.ts");
	assert.equal(formatReadCallDetails("file.ts", { offset: 20 }), "file.ts (offset: 20)");
	assert.equal(formatReadCallDetails("file.ts", { limit: 22 }), "file.ts (limit: 22)");
	assert.equal(formatReadCallDetails("file.ts", { offset: 20, limit: 22 }), "file.ts (offset: 20, limit: 22)");
});

test("reapplies ANSI styling to every logical line", () => {
	const styled = styleMultiline("first\nsecond", (line) => `\x1b[90m${line}\x1b[39m`);
	assert.deepEqual(styled.split("\n"), ["\x1b[90mfirst\x1b[39m", "\x1b[90msecond\x1b[39m"]);
});

test("uses a binary hidden/full expansion model for tool output", () => {
	assert.deepEqual(getBinaryOutputLevels(""), [0]);
	assert.deepEqual(getBinaryOutputLevels("one line"), [0, 3]);
	assert.deepEqual(getBinaryOutputLevels("line 1\nline 2\nline 3"), [0, 3]);
});


test("classifies pending, running, completed, and failed calls", () => {
	assert.equal(classifyCallStatus(false, false, false), "pending");
	assert.equal(classifyCallStatus(false, true, false), "running");
	assert.equal(classifyCallStatus(false, true, true), "success");
	assert.equal(classifyCallStatus(true, true, true), "error");
});

test("expands mixed rows and collapses only when every row is fully expanded", () => {
	assert.equal(shouldExpandAll([
		{ level: 3, levels: [0, 2, 3] },
		{ level: 0, levels: [0, 1, 2, 3] },
	]), true);
	assert.equal(shouldExpandAll([
		{ level: 3, levels: [0, 2, 3] },
		{ level: 2, levels: [0, 2] },
	]), false);
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
