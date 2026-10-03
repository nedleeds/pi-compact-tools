import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import compactTools from "../extensions/compact-tools.ts";
import { loadConfig } from "../extensions/compact-tools-config.ts";
import { renderCodeView } from "../extensions/compact-tools-layout.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import { findAnchorTop } from "../extensions/compact-tools-viewport.ts";
import type { BuiltInDefinition } from "../extensions/compact-tools-types.ts";

/** Original allocation-heavy algorithm: differential tests protect candidate ordering and ties. */
function originalAnchor(before: string[], top: number, height: number, after: string[]): number | undefined {
	const starts = new Map<string, number[]>();
	after.forEach((line, index) => {
		const list = starts.get(line);
		if (list) list.push(index);
		else starts.set(line, [index]);
	});
	const bottom = Math.min(before.length, top + Math.max(1, height));
	const candidates: number[] = [];
	for (let row = top; row < bottom; row++) candidates.push(row);
	for (let row = top - 1; row >= 0; row--) candidates.push(row);
	for (const row of candidates) {
		const window = before.slice(row, row + 2);
		if (window.length < 2 || !window.some((line) => stripTerminalSequences(line).trim().length > 0)) continue;
		let best: number | undefined;
		let bestRun = 0;
		for (const start of starts.get(window[0]!) ?? []) {
			let run = 0;
			while (run < 200 && row + run < before.length && before[row + run] === after[start + run]) run++;
			if (run < 2) continue;
			if (best === undefined || run > bestRun || (run === bestRun && Math.abs(start - row) < Math.abs(best - row))) {
				best = start;
				bestRun = run;
			}
		}
		if (best !== undefined) return Math.max(0, best - (row - top));
	}
	return undefined;
}

test("allocation-free anchor selection matches the original over 2,000 seeded relayouts", () => {
	let seed = 123456789;
	const random = (maximum: number) => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed % maximum;
	};
	const values = ["", " ", "a", "b", "c", "한글 😀", "\x1b[31mtext\x1b[0m", "\x1b[0m"];
	for (let iteration = 0; iteration < 2_000; iteration++) {
		const before = Array.from({ length: random(60) }, () => values[random(values.length)]!);
		const after = [...before];
		after.splice(random(after.length + 1), random(20), ...Array.from({ length: random(10) }, () => values[random(values.length)]!));
		const top = random(before.length + 1);
		const height = random(30);
		assert.equal(findAnchorTop(before, top, height, after), originalAnchor(before, top, height, after), `relayout ${iteration}`);
	}
	assert.equal(findAnchorTop(["a", "b"], 100, 5, ["a", "b"]), originalAnchor(["a", "b"], 100, 5, ["a", "b"]));
});

test("hidden code bodies do not highlight until drawn and resize reuses highlighting", () => {
	initTheme("dark", false);
	let outputPaints = 0;
	const theme = { fg: (_color: string, text: string) => { outputPaints++; return text; } } as Parameters<typeof renderCodeView>[2];
	const component = renderCodeView("one\ntwo\nthree", "NOTES", theme, { rail: "" })!;
	assert.equal(outputPaints, 0, "constructing a hidden result must not paint source lines");
	component.render(80);
	const firstPaints = outputPaints;
	assert.ok(firstPaints > 0);
	component.render(80);
	assert.equal(outputPaints, firstPaints, "cached width must do no work");
	component.render(40);
	assert.equal(outputPaints - firstPaints, 3, "resize paints only gutters, not source again");
});

test("150,000-line file views do not exceed the argument limit and retain six-digit gutters", () => {
	initTheme("dark", false);
	// The highlighter guard should choose plain rendering, but every source line must remain available.
	const theme = { fg: (_color: string, text: string) => text } as Parameters<typeof renderCodeView>[2];
	const component = renderCodeView(Array(150_000).fill("x").join("\n"), "large.ts", theme, { rail: "" })!;
	const rows = component.render(80);
	assert.equal(rows.length, 150_000);
	assert.equal(rows[0], "     1  x");
	assert.equal(rows.at(-1), "150000  x");
	assert.equal(component.render(80), rows, "unchanged layout is cached");
});

for (const source of ["events", "wrapper", "rows"] as const) {
	test(`timing retention is bounded without TUI rendering (${source})`, async () => {
		const runtime = new ToolRuntime();
		runtime.clearTimings();
		const execute = runtime.createTimedExecute({ execute: async () => ({ content: [], details: undefined }) } as unknown as BuiltInDefinition);
		try {
			for (let index = 0; index < 2_100; index++) {
				const id = `${source}-${index}`;
				if (source === "events") {
					runtime.noteExecutionStart(id);
					runtime.noteExecutionEnd(id);
				} else if (source === "wrapper") await execute(id);
				else runtime.syncRow({ toolCallId: id, state: {}, executionStarted: true } as Parameters<ToolRuntime["syncRow"]>[0], true);
			}
			const timings = (globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for("pi.compact-tools.execution-timings")]!;
			assert.equal(timings.size, 2_000);
			assert.equal(runtime.timing(`${source}-0`), undefined);
			assert.ok(runtime.timing(`${source}-2099`)?.endedAt);
		} finally { runtime.reset(true); }
	});
}

test("timing eviction preserves active siblings and bounds an all-active workload", () => {
	const runtime = new ToolRuntime();
	runtime.clearTimings();
	try {
		runtime.noteExecutionStart("long-running");
		for (let index = 0; index < 2_100; index++) {
			runtime.noteExecutionStart(`short-${index}`);
			runtime.noteExecutionEnd(`short-${index}`);
		}
		assert.ok(runtime.timing("long-running"));
		assert.equal(runtime.timing("long-running")!.endedAt, undefined);
		runtime.clearTimings();
		for (let index = 0; index < 2_100; index++) runtime.noteExecutionStart(`active-${index}`);
		const timings = (globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for("pi.compact-tools.execution-timings")]!;
		assert.equal(timings.size, 2_000);
		assert.ok(runtime.timing("active-2099"));
	} finally { runtime.reset(true); }
});

for (const style of ["compact", "claude", "codex"] as const) test(`existing real host tool rows repaint on theme changes but reuse unchanged results (${style})`, () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-theme-reuse-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ style, tools: ["read", "write", "edit"], auto_compact: { read: false, write: false } }));
	const definitions = new Map<string, ToolDefinition<any, any, any>>();
	const handlers = new Map<string, Function>();
	try {
		compactTools({
			on: (name: string, handler: Function) => handlers.set(name, handler),
			registerTool: (definition: ToolDefinition<any, any, any>) => definitions.set(definition.name, definition),
			registerMarkdownTransformer() {}, registerCommand() {}, registerShortcut() {},
		} as unknown as ExtensionAPI);
		const cases = [
			{ name: "read", args: { path: "a.ts" }, result: { content: [{ type: "text" as const, text: "const a = 1;" }], details: undefined } },
			{ name: "write", args: { path: "a.ts", content: "const a = 1;" }, result: { content: [{ type: "text" as const, text: "Written" }], details: undefined } },
			{ name: "edit", args: { path: "a.ts" }, result: { content: [{ type: "text" as const, text: "Edited" }], details: { diff: "-1 const a = 1;\n+1 const a = 2;" } } },
		];
		for (const { name, args, result } of cases) {
			initTheme("dark", false);
			const row = new ToolExecutionComponent(name, `theme-${name}`, args, { showImages: false }, definitions.get(name), { requestRender() {} } as never, directory);
			row.setArgsComplete();
			row.setExpanded(true);
			row.updateResult({ ...result, isError: false });
			const internals = row as unknown as { resultRendererComponent: unknown };
			const first = internals.resultRendererComponent;
			const dark = row.render(80);
			row.invalidate();
			assert.equal(internals.resultRendererComponent, first, `${name}: same-theme result is reused`);
			initTheme("light", false);
			row.invalidate();
			assert.notEqual(internals.resultRendererComponent, first, `${name}: new theme rebuilds result`);
			const light = row.render(80);
			assert.notDeepEqual(light, dark, `${name}: colors must change`);
			assert.deepEqual(light.map(stripTerminalSequences), dark.map(stripTerminalSequences), `${name}: text and layout must not change`);
		}
	} finally {
		handlers.get("session_shutdown")?.({ reason: "shutdown" });
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missing and malformed configuration keep defaults without reading untrusted project files", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-config-errors-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	const errors: unknown[][] = [];
	const error = console.error;
	console.error = (...args) => errors.push(args);
	try {
		assert.equal(loadConfig().previewLines, 10);
		assert.equal(errors.length, 0, "a missing config is not an error");
		mkdirSync(join(directory, ".pi"));
		writeFileSync(join(directory, ".pi", "compact-tools.json"), "{");
		loadConfig(directory, false);
		assert.equal(errors.length, 0, "untrusted project file is not read");
		assert.equal(loadConfig(directory, true).previewLines, 10);
		assert.equal(errors.length, 1, "malformed trusted config warns once");
		writeFileSync(join(directory, "compact-tools.json"), "null");
		assert.equal(loadConfig().previewLines, 10);
		assert.equal(errors.length, 2, "non-object config warns");
	} finally {
		console.error = error;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
