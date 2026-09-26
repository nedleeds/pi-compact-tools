/**
 * Claude-style group lines are kept once drawn: a finished group is not drawn
 * again until something it shows changes, and every such change is drawn.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/compact-tools-config.ts";
import { ToolGroupController } from "../extensions/compact-tools-grouping.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";

const strip = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/gu, ""));

/** Pi's theme, counting how often a color is asked for. */
function countingTheme(): { theme: Theme; calls: () => number } {
	let calls = 0;
	const theme = new Proxy(piTheme as Theme, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (key !== "fg" || typeof value !== "function") return value;
			return (...args: unknown[]) => { calls++; return (value as (...a: unknown[]) => string).apply(target, args); };
		},
	});
	return { theme, calls: () => calls };
}

/** A chat with the group controller bound to it, as Pi mounts it. */
function groupedChat(theme: Theme) {
	const runtime = new ToolRuntime();
	runtime.configure({ ...DEFAULT_CONFIG, style: "claude" });
	const controller = new ToolGroupController(runtime);
	const chat = new Container();
	let factory: ((tui: unknown) => Component) | undefined;
	controller.bind({
		ui: { theme, setWidget: (_key: string, value: unknown) => { factory = value as typeof factory; } },
	} as unknown as ExtensionContext);
	factory!({ children: [{ children: [chat] }], requestRender() {} });
	return { chat, controller };
}

let sequence = 0;

async function finishedRows(harness: Awaited<ReturnType<typeof loadExtension>>, count: number) {
	const children: unknown[] = [];
	for (let index = 0; index < count; index++) {
		const row = makeRow("read", `g-${++sequence}`, { path: `src/${index}.ts` }, harness.definitions.get("read"));
		row.updateResult({ ...text("a\nb"), isError: false } as never);
		children.push(row);
		// A text answer ends each group, so every row is a group of its own.
		children.push(new AssistantMessageComponent({ content: [{ type: "text", text: `answer ${index}` }], stopReason: "stop" } as never));
	}
	return children;
}

test("a finished group line is drawn once, however many frames pass", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	const { theme, calls } = countingTheme();
	const { chat, controller } = groupedChat(theme);
	chat.children = (await finishedRows(harness, 40)) as Component[];
	const first = chat.render(100);
	const afterFirst = calls();
	for (let frame = 0; frame < 50; frame++) assert.deepEqual(chat.render(100), first);
	// Each frame resolves the palette once; no group asks for a color again.
	const perFrame = (calls() - afterFirst) / 50;
	const paletteOnly = (() => {
		const before = calls();
		(controller as unknown as { resolvePaint(): unknown }).resolvePaint();
		return calls() - before;
	})();
	assert.equal(perFrame, paletteOnly, "only the per-frame palette, not one draw per group");
	controller.dispose();
	shutdown(harness);
});

test("a running group line is drawn every frame, and cached once it finishes", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: false });
	const { theme, calls } = countingTheme();
	const { chat, controller } = groupedChat(theme);
	const row = makeRow("read", `g-${++sequence}`, { path: "src/x.ts" }, harness.definitions.get("read"));
	row.setArgsComplete();
	row.markExecutionStarted();
	chat.children = [row] as unknown as Component[];
	chat.render(100);
	const before = calls();
	chat.render(100);
	const running = calls() - before;
	row.updateResult({ ...text("a"), isError: false } as never, false);
	const finished = strip(chat.render(100));
	assert.match(finished.join("\n"), /Read 1 file/u);
	const settled = calls();
	chat.render(100);
	assert.ok(running > calls() - settled, "a running group draws itself; a finished one does not");
	controller.dispose();
	shutdown(harness);
});

test("every change a finished group shows is drawn", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	const { chat, controller } = groupedChat(piTheme as Theme);
	const [row] = (await finishedRows(harness, 1)) as Array<ReturnType<typeof makeRow>>;
	chat.children = [row] as unknown as Component[];
	const done = strip(chat.render(100));
	assert.match(done[1]!, /Read 1 file \(ctrl\+o to expand\)/u);

	// Its result is replaced: the failure shows.
	row!.updateResult({ ...text("ENOENT: gone"), isError: true } as never);
	assert.match(strip(chat.render(100)).join("\n"), /Error: ENOENT: gone/u);

	// A narrower width fits the line again.
	assert.match(strip(chat.render(12)).join("\n"), /…/u);

	// Ctrl+O opens it: the hint goes and the row itself shows.
	row!.setExpanded(true);
	const opened = strip(chat.render(100));
	assert.doesNotMatch(opened[1]!, /ctrl\+o/u);
	assert.ok(opened.some((line) => /Read\(src\/0\.ts\)/u.test(line)));
	row!.setExpanded(false);

	// A row joins it: the count follows.
	const second = makeRow("grep", `g-${++sequence}`, { pattern: "x", path: "src" }, harness.definitions.get("grep"));
	second.updateResult({ ...text("src/a.ts:1: x"), isError: false } as never);
	chat.children = [row, second] as unknown as Component[];
	assert.match(strip(chat.render(100))[1]!, /Searched for 1 pattern, read 1 file/u);

	// Its arguments change: what it counts follows.
	second.updateArgs({ path: "src/y.ts" });
	(second as unknown as { toolName: string }).toolName = "read";
	assert.match(strip(chat.render(100))[1]!, /Read 2 files/u);

	// Another row takes a row's place: what it counts follows, even over the same arguments and result.
	const args = { path: "src/z" };
	const result = { ...text("z"), isError: false };
	const before = makeRow("read", `g-${++sequence}`, args, harness.definitions.get("read"));
	before.updateResult(result as never);
	chat.children = [row, before] as unknown as Component[];
	assert.match(strip(chat.render(100))[1]!, /Read 2 files/u);
	const after = makeRow("ls", `g-${++sequence}`, args, harness.definitions.get("ls"));
	after.updateResult(result as never);
	chat.children = [row, after] as unknown as Component[];
	assert.match(strip(chat.render(100))[1]!, /Read 1 file, listed 1 directory/u);
	chat.children = [row, second] as unknown as Component[];

	// A new theme repaints it.
	const dark = chat.render(100);
	initTheme("light", false);
	try {
		const light = chat.render(100);
		assert.deepEqual(strip(light), strip(dark));
		assert.notDeepEqual(light, dark);
	} finally {
		initTheme("dark", false);
	}
	assert.deepEqual(chat.render(100), dark);
	controller.dispose();
	shutdown(harness);
});

test.after(restoreClocks);
