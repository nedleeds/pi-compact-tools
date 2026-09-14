import assert from "node:assert/strict";
import test from "node:test";
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
