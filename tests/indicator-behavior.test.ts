/**
 * How the running dot is kept alive, and what a row draws when it cannot run: bound
 * to Pi's terminal, a live row draws exactly its golden frames without Pi
 * rebuilding it; a row restored from the session, or left without a result, never
 * animates; and a row that left the screen stops asking for frames.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { LiveCallContainer } from "../extensions/compact-tools-layout.ts";
import { paintIndicator } from "../extensions/compact-tools-palette.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
	advance, animate, CASES, CUSTOM_CASES, elapse, INDICATOR_INTERVAL_MS, lifecycle, loadExtension, makeRow, MODE_CONFIGS,
	readable, restoreClocks, shutdown, text, type Case, type Harness,
} from "./indicator-harness.ts";

const golden = JSON.parse(readFileSync(join(import.meta.dirname, "golden", "indicator.json"), "utf8")) as Record<string, string[][]>;

/** Where lifecycle() draws the finished row, and the row once toggled after it. */
const FINISHED_FRAME = 24;
const TOGGLED_FRAME = 27;
/** Frames lifecycle() animates while the row is running: streaming, executing, and streaming output. */
const RUNNING_TICKS = 3 + 15 + 2;
/** Pi rebuilds a row on each change it makes in lifecycle(): made, expanded, args, complete, started, output, result, toggled. */
const LIFECYCLE_REBUILDS = 8;

const readableFrames = (frames: string[][]) => frames.map((frame) => frame.map(readable));
/** A duration the row could only know by having timed its run. */
const withoutDuration = (frame: string[]) => frame.map((line) => line.replace(/ in (?:\d+\.\d{3}s|\d+m \d+s|\d+h \d+m \d+s)/gu, ""));
/**
 * A restored row matches the live one's finished frame less its duration. Where the
 * shorter status line wraps differently, the call line must still match exactly and
 * the rest must read the same.
 */
function assertFinishedLike(actual: string[], live: string[], message: string): void {
	const expected = withoutDuration(live);
	if (actual.length === expected.length && actual.every((line, index) => line === expected[index])) return;
	assert.deepEqual(actual.slice(0, 2), expected.slice(0, 2), `${message}: call line`);
	const plain = (lines: string[]) => lines.slice(2).map((line) => line.replace(/\\e\[[0-9;]*m/gu, "")).join(" ").replace(/\s+/gu, " ");
	assert.equal(plain(actual), plain(expected), `${message}: result`);
}

const goldenFrames = (key: string) => {
	assert.ok(key in golden, `no golden lifecycle for ${key}`);
	return golden[key]!;
};

let sequence = 0;
const nextId = (label: string) => `${label}-${++sequence}`;

/** A built-in definition whose call renderer counts how often Pi rebuilds the row. */
function counted(harness: Harness, name: string): { definition: object; calls: () => number } {
	const definition = harness.definitions.get(name)! as Record<string, any>;
	let calls = 0;
	return {
		definition: { ...definition, renderCall: (...args: unknown[]) => { calls++; return definition.renderCall(...args); } },
		calls: () => calls,
	};
}

function tick(frames = 1): void {
	for (let frame = 0; frame < frames; frame++) mock.timers.tick(INDICATOR_INTERVAL_MS);
}

function running(harness: Harness, name: string, definition: object | undefined, args: object = CASES[name]?.args ?? {}) {
	const id = nextId(name);
	const row = makeRow(name, id, args, definition);
	row.setArgsComplete();
	harness.handlers.get("tool_execution_start")?.({ toolCallId: id, toolName: name, args });
	row.markExecutionStarted();
	return { row, id };
}

/** Rows as Pi restores them from a session: made, expanded to match the transcript, and given the saved result. */
function restored(name: string, id: string, definition: object | undefined, args: object, expanded: boolean, result?: object) {
	const row = makeRow(name, id, args, definition);
	row.setExpanded(expanded);
	if (result) row.updateResult(result as never);
	return row;
}

function customDefinition(key: string, outcome: Case & { author?: object }) {
	const name = key.split("@")[0]!;
	return { name, definition: outcome.author ? { name, ...outcome.author } : undefined };
}

const dotOf = (lines: string[]) => lines.join("\n").match(/\x1b\[[0-9;]*m⦁/u)?.[0];
/** The dot of a row that waits rather than runs. */
const PENDING_DOT = dotOf([paintIndicator(theme, "pending", 0)]);

for (const [mode, config] of Object.entries(MODE_CONFIGS)) {
	test(`bound to the terminal, built-in rows draw their golden frames and are never rebuilt to animate (${mode})`, async () => {
		for (const [name, outcome] of Object.entries(CASES)) {
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					for (const width of [100, 44]) {
						const key = `${mode}/${name}/${failed ? "failed" : "done"}/${expanded ? "open" : "closed"}/${width}`;
						const harness = await loadExtension(config, { tui: true, idle: false });
						const { definition, calls } = counted(harness, name);
						const frames = lifecycle(harness, name, nextId("bound"), definition, outcome, failed, expanded, width);
						assert.deepEqual(readableFrames(frames), goldenFrames(key), key);
						assert.equal(calls(), LIFECYCLE_REBUILDS, `${key}: rebuilt only when Pi changed the row`);
						assert.equal(harness.requestRenders(), RUNNING_TICKS, `${key}: one frame asked for per running frame`);
						shutdown(harness);
					}
				}
			}
		}
	});

	test(`bound to the terminal, custom rows draw their golden frames (${mode})`, async () => {
		for (const [key, outcome] of Object.entries(CUSTOM_CASES)) {
			const { name, definition } = customDefinition(key, outcome);
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					const goldenKey = `${mode}/custom:${key}/${failed ? "failed" : "done"}/${expanded ? "open" : "closed"}/100`;
					const harness = await loadExtension(config, { tui: true, idle: false });
					const frames = lifecycle(harness, name, nextId("custom"), definition, outcome, failed, expanded, 100);
					assert.deepEqual(readableFrames(frames), goldenFrames(goldenKey), goldenKey);
					assert.equal(harness.requestRenders(), RUNNING_TICKS, goldenKey);
					shutdown(harness);
				}
			}
		}
	});

	test(`bound to the terminal, parallel rows share one frame request per frame (${mode})`, async () => {
		const harness = await loadExtension(config, { tui: true, idle: false });
		const rows = ["read", "grep", "bash"].map((name) => ({ name, ...counted(harness, name) }))
			.map(({ name, definition, calls }) => ({ ...running(harness, name, definition), calls }));
		const rebuilt = rows.map(({ calls }) => calls());
		const frames: string[][] = [];
		animate(rows.map(({ row }) => row), 4, 100, (frame) => frames.push(frame));
		assert.equal(harness.requestRenders(), 4, "one request per frame, not one per row");
		assert.deepEqual(rows.map(({ calls }) => calls()), rebuilt, "no row is rebuilt to animate");
		advance(500);
		harness.handlers.get("tool_execution_end")?.({ toolCallId: rows[0]!.id, isError: false });
		rows[0]!.row.updateResult({ ...CASES.read!.success, isError: false } as never, false);
		animate(rows.map(({ row }) => row), 4, 100, (frame) => frames.push(frame));
		assert.deepEqual(readableFrames(frames), goldenFrames(`${mode}/parallel`));
		assert.equal(harness.requestRenders(), 8);
		shutdown(harness);
	});

	test(`bound to the terminal, a click on a running call still toggles it (${mode})`, async () => {
		const harness = await loadExtension(config, { tui: true, idle: false });
		const { row } = running(harness, "bash", harness.definitions.get("bash"));
		row.updateResult({ ...CASES.bash!.partial!, isError: false } as never, true);
		const frames: string[][] = [row.render(100)];
		const handled = row.handleMouse({ type: "click", button: "left", x: 3, y: 1, width: 100, height: frames[0]!.length } as never);
		frames.push([`handled: ${handled?.handled === true}`, `expanded: ${(row as unknown as { expanded: boolean }).expanded}`]);
		animate([row], 2, 100, (frame) => frames.push(frame));
		assert.deepEqual(readableFrames(frames), goldenFrames(`${mode}/click`));
		shutdown(harness);
	});

	test(`a restored row draws what the live row finished with, less the time it never measured (${mode})`, async () => {
		for (const [name, outcome] of Object.entries(CASES)) {
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					for (const width of [100, 44]) {
						const key = `${mode}/${name}/${failed ? "failed" : "done"}/${expanded ? "open" : "closed"}/${width}`;
						const live = goldenFrames(key);
						const harness = await loadExtension(config, { tui: true, idle: true });
						const { definition, calls } = counted(harness, name);
						const row = restored(name, nextId("restored"), definition, outcome.args, expanded,
							{ ...(failed ? outcome.failure : outcome.success), isError: failed });
						const drawn = row.render(width).map(readable);
						if (width === 100) assert.deepEqual(drawn, withoutDuration(live[FINISHED_FRAME]!), `${key}: finished`);
						else assertFinishedLike(drawn, live[FINISHED_FRAME]!, `${key}: finished`);
						assert.equal(dotOf(row.render(width)), dotOf([paintIndicator(theme, failed ? "error" : "success", 0)]),
							`${key}: settled dot`);
						tick(30);
						assert.deepEqual(row.render(width).map(readable), drawn, `${key}: never animates`);
						assert.equal(harness.requestRenders(), 0, `${key}: asks for no frames`);
						row.setExpanded(!expanded);
						const toggled = row.render(width).map(readable);
						if (width === 100) assert.deepEqual(toggled, withoutDuration(live[TOGGLED_FRAME]!), `${key}: toggled`);
						else assertFinishedLike(toggled, live[TOGGLED_FRAME]!, `${key}: toggled`);
						assert.equal(calls(), 4, `${key}: made, expanded, result, toggled`);
						shutdown(harness);
					}
				}
			}
		}
	});

	test(`a restored custom row draws what the live row finished with (${mode})`, async () => {
		for (const [key, outcome] of Object.entries(CUSTOM_CASES)) {
			const { name, definition } = customDefinition(key, outcome);
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					const goldenKey = `${mode}/custom:${key}/${failed ? "failed" : "done"}/${expanded ? "open" : "closed"}/100`;
					const harness = await loadExtension(config, { tui: true, idle: true });
					const row = restored(name, nextId("restored-custom"), definition, outcome.args, expanded,
						{ ...(failed ? outcome.failure : outcome.success), isError: failed });
					assert.deepEqual(row.render(100).map(readable), withoutDuration(goldenFrames(goldenKey)[FINISHED_FRAME]!), goldenKey);
					tick(30);
					assert.equal(harness.requestRenders(), 0, goldenKey);
					shutdown(harness);
				}
			}
		}
	});

	test(`after /reload a restored row keeps the time this process measured (${mode})`, async () => {
		const id = nextId("reloaded");
		const first = await loadExtension(config, { tui: true, idle: false });
		const frames = lifecycle(first, "bash", id, first.definitions.get("bash"), CASES.bash!, false, false, 100);
		assert.deepEqual(readableFrames(frames), goldenFrames(`${mode}/bash/done/closed/100`));
		first.handlers.get("session_shutdown")!({ reason: "reload" });
		const second = await loadExtension(config, { tui: true, idle: true, reason: "reload" });
		const row = restored("bash", id, second.definitions.get("bash"), CASES.bash!.args, false,
			{ ...CASES.bash!.success, isError: false });
		assert.deepEqual(row.render(100).map(readable), goldenFrames(`${mode}/bash/done/closed/100`)[FINISHED_FRAME]);
		shutdown(second);
	});
}

test("a restored row that never got its result waits, and never animates", async () => {
	for (const [name, outcome] of Object.entries(CASES)) {
		const harness = await loadExtension({ style: "compact" }, { tui: true, idle: true });
		const row = restored(name, nextId("orphan"), harness.definitions.get(name), outcome.args, false);
		const drawn = row.render(100);
		assert.equal(dotOf(drawn), PENDING_DOT, name);
		tick(100);
		assert.deepEqual(row.render(100), drawn, name);
		assert.equal(harness.requestRenders(), 0, name);
		// A new run does not revive it: Pi forgot it when the session was restored.
		harness.handlers.get("agent_start")!({});
		tick(10);
		assert.deepEqual(row.render(100), drawn, name);
		assert.equal(harness.requestRenders(), 0, name);
		shutdown(harness);
	}
});

test("when the run ends, a row left without a result stops pulsing and waits", async () => {
	const harness = await loadExtension({ style: "compact" }, { tui: true, idle: true });
	harness.handlers.get("agent_start")!({});
	const { definition, calls } = counted(harness, "bash");
	const { row } = running(harness, "bash", definition);
	const rebuilt = calls();
	for (let frame = 0; frame < 5; frame++) {
		tick();
		row.render(100);
	}
	assert.equal(harness.requestRenders(), 5);
	assert.notEqual(dotOf(row.render(100)), PENDING_DOT);
	harness.handlers.get("agent_end")!({ messages: [] });
	assert.equal(harness.requestRenders(), 6, "one last frame repaints it");
	assert.equal(dotOf(row.render(100)), PENDING_DOT, "painted as waiting, without a rebuild");
	assert.equal(calls(), rebuilt);
	tick(50);
	assert.equal(harness.requestRenders(), 6, "and it asks for no more");
	// The next run cannot give it a result: Pi drops rows it was waiting on when a run starts.
	harness.handlers.get("agent_start")!({});
	for (let frame = 0; frame < 10; frame++) {
		tick();
		row.render(100);
	}
	assert.equal(harness.requestRenders(), 6);
	assert.equal(dotOf(row.render(100)), PENDING_DOT);
	shutdown(harness);
});

test("a running row that is no longer drawn stops asking for frames, and resumes when drawn", async () => {
	const harness = await loadExtension({ style: "compact" }, { tui: true, idle: false });
	const { row } = running(harness, "bash", harness.definitions.get("bash"));
	row.render(100);
	tick(3);
	assert.equal(harness.requestRenders(), 3);
	// Left the transcript: nothing draws it any more.
	elapse(1_600);
	tick();
	tick(100);
	assert.equal(harness.requestRenders(), 3, "an undrawn row asks for no frames");
	// Drawn again, it picks the animation back up.
	row.render(100);
	tick(4);
	assert.equal(harness.requestRenders(), 7);
	shutdown(harness);
});

test("a running row that keeps being drawn is never dropped", async () => {
	const harness = await loadExtension({ style: "compact" }, { tui: true, idle: false });
	const { row } = running(harness, "bash", harness.definitions.get("bash"));
	const dots = new Set<string | undefined>();
	for (let frame = 0; frame < 200; frame++) {
		elapse(INDICATOR_INTERVAL_MS);
		tick();
		dots.add(dotOf(row.render(100)));
	}
	assert.equal(harness.requestRenders(), 200);
	// Fourteen frames trace a symmetric pulse: eight distinct shades, each shown.
	assert.equal(dots.size, 8, "every shade of the pulse shows");
	shutdown(harness);
});

test("a running row folded into a Claude group keeps its group line pulsing", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: false });
	const { row } = running(harness, "read", harness.definitions.get("read"));
	let rowDraws = 0;
	const draw = row.render.bind(row);
	row.render = (width: number) => { rowDraws++; return draw(width); };
	harness.chat.children = [row];
	const headers = new Set<string>();
	for (let frame = 0; frame < 100; frame++) {
		elapse(INDICATOR_INTERVAL_MS);
		tick();
		const lines = harness.chat.render(100);
		headers.add(lines.find((line) => line.includes("⦁")) ?? "");
	}
	assert.equal(rowDraws, 0, "the folded row itself is not drawn");
	assert.equal(harness.requestRenders(), 100, "the group line keeps the clock going");
	assert.ok(headers.size > 5, "and it pulses");
	shutdown(harness);
});

test("silent mode asks for no frames for the rows it hides", async () => {
	const harness = await loadExtension({ style: "compact" }, { tui: true, idle: false });
	const { row } = running(harness, "bash", harness.definitions.get("bash"));
	row.render(100);
	const silent = (globalThis as Record<symbol, { active: boolean; enabled: boolean }>)[Symbol.for("pi-compact-tools.silent.state")]!;
	silent.active = true;
	silent.enabled = true;
	try {
		tick(10);
		assert.equal(harness.requestRenders(), 0);
	} finally {
		silent.enabled = false;
	}
	row.render(100);
	tick(3);
	assert.equal(harness.requestRenders(), 3);
	shutdown(harness);
});

test("shutting down stops the animation", async () => {
	const harness = await loadExtension({ style: "compact" }, { tui: true, idle: false });
	running(harness, "bash", harness.definitions.get("bash")).row.render(100);
	tick(2);
	shutdown(harness);
	tick(20);
	assert.equal(harness.requestRenders(), 2);
});

test("unbound from a terminal, each running row is still rebuilt to animate, as before", async () => {
	const harness = await loadExtension({ style: "compact" });
	const { definition, calls } = counted(harness, "bash");
	const { row } = running(harness, "bash", definition);
	const rebuilt = calls();
	tick(7);
	assert.equal(calls() - rebuilt, 7);
	assert.equal(harness.requestRenders(), 0);
	row.updateResult({ ...text("done"), isError: false } as never, false);
	shutdown(harness);
});

test("a live call lays out each dot it shows once, and reflows on width", () => {
	let indicator = "A";
	const built: string[] = [];
	let childDraws = 0;
	const container = new LiveCallContainer(() => indicator, (dot) => {
		built.push(dot);
		return { render: (width: number) => [`${dot} title ${width}`], invalidate() {} };
	});
	const clicks: number[] = [];
	container.addChild({
		render: () => { childDraws++; return ["arg 1", "arg 2"]; },
		invalidate() {},
		handleMouse: (event: { y: number }) => { clicks.push(event.y); return { handled: true }; },
	} as Component);
	const first = container.render(40);
	assert.deepEqual(first, ["A title 40", "arg 1", "arg 2"]);
	assert.equal(container.render(40), first, "an unchanged dot reuses the lines");
	indicator = "B";
	assert.deepEqual(container.render(40), ["B title 40", "arg 1", "arg 2"]);
	indicator = "A";
	container.render(40);
	assert.deepEqual(built, ["A", "B"], "each dot's title is laid out once");
	assert.deepEqual(container.render(20), ["A title 20", "arg 1", "arg 2"], "a new width reflows");
	const draws = childDraws;
	container.render(20);
	assert.equal(childDraws, draws, "cached lines are not redrawn");
	// Clicks reach the arguments beneath the title at their own row.
	assert.equal(container.handleMouse!({ type: "click", button: "left", x: 0, y: 2, width: 20, height: 3 } as never)?.handled, true);
	assert.deepEqual(clicks, [1]);
	container.invalidate();
	container.render(20);
	assert.deepEqual(built, ["A", "B", "A"], "invalidating lays the title out again");
});

test.after(restoreClocks);
