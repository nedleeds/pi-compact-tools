/**
 * Claude-style group lines are kept once drawn: a finished group is not drawn
 * again until something it shows changes, and every such change is drawn.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { AssistantMessageComponent, createReadToolDefinition, initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/compact-tools-config.ts";
import { ToolGroupController } from "../extensions/compact-tools-grouping.ts";
import { paintIndicator } from "../extensions/compact-tools-palette.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { announce, loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";

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
	const id = `g-${++sequence}`;
	announce(harness, id, "read");
	const row = makeRow("read", id, { path: "src/x.ts" }, harness.definitions.get("read"));
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

const dotOf = (lines: string[]) => lines.join("\n").match(/\x1b\[[0-9;]*m⦁/u)?.[0];
const PENDING_DOT = dotOf([paintIndicator(piTheme as Theme, "pending", 0)]);
const ERROR_DOT = dotOf([paintIndicator(piTheme as Theme, "error", 0)]);

/** The group's line and, opened, its row's own line: they must agree. */
function groupAndRow(harness: Awaited<ReturnType<typeof loadExtension>>, row: ReturnType<typeof makeRow>) {
	const collapsed = harness.chat.render(100);
	row.setExpanded(true);
	const opened = harness.chat.render(100);
	row.setExpanded(false);
	const rowLine = opened.find((line) => /Read\(src\//u.test(strip([line])[0]!))!;
	return { collapsed, header: collapsed.find((line) => line.includes("⦁"))!, rowLine };
}

test("a group whose call was restored without its result waits, as its row does", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	const row = makeRow("read", `g-${++sequence}`, { path: "src/a.ts" }, harness.definitions.get("read"));
	harness.chat.children = [row];
	const { collapsed, header, rowLine } = groupAndRow(harness, row);
	assert.deepEqual(strip(collapsed).filter((line) => line.trim()), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	assert.equal(dotOf([header]), PENDING_DOT);
	assert.equal(dotOf([rowLine]), PENDING_DOT, "the group and its row agree");
	mock.timers.tick(45 * 20);
	assert.equal(harness.requestRenders(), 0, "nothing animates");
	// A new run does not revive it. The dot alone cannot tell: a pulse starts in the waiting shade.
	harness.handlers.get("agent_start")!({});
	const revived = groupAndRow(harness, row);
	assert.deepEqual(strip(revived.collapsed).filter((line) => line.trim()), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	assert.equal(dotOf([revived.header]), PENDING_DOT);
	shutdown(harness);
});

test("when the run ends, a group whose call got no result stops running with it", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	harness.handlers.get("agent_start")!({});
	const id = `g-${++sequence}`;
	announce(harness, id, "read");
	const row = makeRow("read", id, { path: "src/a.ts" }, harness.definitions.get("read"));
	row.setArgsComplete();
	harness.handlers.get("tool_execution_start")!({ toolCallId: (row as unknown as { toolCallId: string }).toolCallId, toolName: "read", args: {} });
	row.markExecutionStarted();
	harness.chat.children = [row];
	const running = strip(harness.chat.render(100)).filter((line) => line.trim());
	assert.deepEqual(running, [" ⦁ Reading 1 file… (ctrl+o to expand)", " └ src/a.ts"]);
	mock.timers.tick(45 * 3);
	harness.chat.render(100);
	const asked = harness.requestRenders();
	assert.ok(asked > 0, "it pulsed while the run went on");
	harness.handlers.get("agent_end")!({ messages: [] });
	const { collapsed, header, rowLine } = groupAndRow(harness, row);
	assert.deepEqual(strip(collapsed).filter((line) => line.trim()), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	assert.equal(dotOf([header]), PENDING_DOT);
	assert.equal(dotOf([rowLine]), PENDING_DOT, "the group and its row agree");
	const after = harness.requestRenders();
	for (let frame = 0; frame < 20; frame++) {
		mock.timers.tick(45);
		harness.chat.render(100);
	}
	assert.equal(harness.requestRenders(), after, "and it asks for no more frames");
	// The next run cannot give it a result: Pi drops the calls it waited on when a run starts.
	harness.handlers.get("agent_start")!({});
	assert.deepEqual(strip(harness.chat.render(100)).filter((line) => line.trim()), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	shutdown(harness);
});

test("a waiting call leaves a finished group waiting, and a failure still shows first", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	const done = makeRow("read", `g-${++sequence}`, { path: "src/a.ts" }, harness.definitions.get("read"));
	done.updateResult({ ...text("a"), isError: false } as never);
	const waiting = makeRow("read", `g-${++sequence}`, { path: "src/b.ts" }, harness.definitions.get("read"));
	harness.chat.children = [done, waiting];
	const header = harness.chat.render(100).find((line) => line.includes("⦁"))!;
	assert.equal(strip([header])[0], " ⦁ Read 2 files (ctrl+o to expand)");
	assert.equal(dotOf([header]), PENDING_DOT);
	const failed = makeRow("read", `g-${++sequence}`, { path: "src/c.ts" }, harness.definitions.get("read"));
	failed.updateResult({ ...text("ENOENT: gone"), isError: true } as never);
	harness.chat.children = [done, waiting, failed];
	const withFailure = harness.chat.render(100);
	assert.equal(dotOf([withFailure.find((line) => line.includes("⦁"))!]), ERROR_DOT);
	assert.match(strip(withFailure).join("\n"), /Error: ENOENT: gone/u);
	shutdown(harness);
});

/** Claude style with read left to Pi's own renderer, as `tools` allows. */
const PI_DRAWS_READ = { style: "claude", tools: ["write", "edit", "bash", "grep", "find", "ls"] };
const piRead = (id: string) => makeRow("read", id, { path: "src/a.ts" }, createReadToolDefinition("/project"));
const lines = (harness: Awaited<ReturnType<typeof loadExtension>>) => strip(harness.chat.render(100)).filter((line) => line.trim());

test("a call Pi draws itself, restored without its result, is not revived by the next run", async () => {
	const harness = await loadExtension(PI_DRAWS_READ, { tui: true, idle: true });
	assert.equal(harness.definitions.has("read"), false, "read keeps Pi's renderer");
	harness.chat.children = [piRead(`pi-${++sequence}`)];
	assert.deepEqual(lines(harness), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	harness.handlers.get("agent_start")!({});
	assert.deepEqual(lines(harness), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	harness.handlers.get("agent_end")!({ messages: [] });
	harness.handlers.get("agent_start")!({});
	assert.deepEqual(lines(harness), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	shutdown(harness);
});

test("a restored call is known as restored even if no group drew it before the next run", async () => {
	const harness = await loadExtension(PI_DRAWS_READ, { tui: true, idle: true });
	const silent = (globalThis as Record<symbol, { active: boolean; enabled: boolean }>)[Symbol.for("pi-compact-tools.silent.state")]!;
	silent.active = true;
	silent.enabled = true;
	try {
		// Silent mode hides the transcript, so the group never draws while idle.
		harness.chat.children = [piRead(`pi-${++sequence}`)];
		harness.chat.render(100);
		harness.handlers.get("agent_start")!({});
	} finally {
		silent.enabled = false;
	}
	assert.deepEqual(lines(harness), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	shutdown(harness);
});

test("a call Pi draws itself runs with its run, and waits once the run ends without its result", async () => {
	const harness = await loadExtension(PI_DRAWS_READ, { tui: true, idle: true });
	harness.handlers.get("agent_start")!({});
	const [runningId, finishedId] = [`pi-${++sequence}`, `pi-${++sequence}`];
	announce(harness, runningId, "read");
	announce(harness, finishedId, "read");
	const running = piRead(runningId);
	const finished = piRead(finishedId);
	harness.chat.children = [running, finished];
	assert.deepEqual(lines(harness), [" ⦁ Reading 1 file… (ctrl+o to expand)", " └ src/a.ts"]);
	finished.updateResult({ ...text("a"), isError: false } as never);
	assert.deepEqual(lines(harness), [" ⦁ Reading 1 file… (ctrl+o to expand)", " └ src/a.ts"]);
	harness.handlers.get("agent_end")!({ messages: [] });
	assert.deepEqual(lines(harness), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	harness.handlers.get("agent_start")!({});
	assert.deepEqual(lines(harness), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	shutdown(harness);
});

test("rebuilt mid-run, an old call's new row still waits and a running call's new row still runs", async () => {
	for (const config of [{ style: "claude" }, PI_DRAWS_READ]) {
		const harness = await loadExtension(config, { tui: true, idle: true });
		const read = (id: string, path: string) =>
			makeRow("read", id, { path }, harness.definitions.get("read") ?? createReadToolDefinition("/project"));
		const start = (row: ReturnType<typeof makeRow>, id: string) => {
			row.setArgsComplete();
			harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "read", args: {} });
			row.markExecutionStarted();
		};
		// A rebuilt row is marked as running as Pi marks it, without announcing the call again.
		const rebuiltRunning = (row: ReturnType<typeof makeRow>) => {
			row.setArgsComplete();
			row.markExecutionStarted();
		};
		const old = `old-${++sequence}`;
		const live = `live-${++sequence}`;
		harness.handlers.get("agent_start")!({});
		announce(harness, old, "read");
		start(read(old, "src/old.ts"), old);
		harness.handlers.get("agent_end")!({ messages: [] });
		harness.handlers.get("agent_start")!({});
		announce(harness, live, "read");
		start(read(live, "src/live.ts"), live);
		// Pi announces nothing for rows it makes again for calls it already has.
		// Pi rebuilds the transcript, compacting between turns: new rows for the same calls.
		const oldAgain = read(old, "src/old.ts");
		const liveAgain = read(live, "src/live.ts");
		rebuiltRunning(liveAgain);
		harness.chat.children = [oldAgain, new AssistantMessageComponent({ content: [{ type: "text", text: "Next." }], stopReason: "stop" } as never), liveAgain];
		const drawn = lines(harness);
		assert.equal(drawn[0], " ⦁ Read 1 file (ctrl+o to expand)", JSON.stringify(config));
		assert.equal(drawn.at(-2), " ⦁ Reading 1 file… (ctrl+o to expand)", JSON.stringify(config));
		assert.equal(drawn.at(-1), " └ src/live.ts", JSON.stringify(config));
		if (harness.definitions.has("read")) {
			// The rows themselves agree: only the running one asks for frames.
			const asked = harness.requestRenders();
			for (let frame = 0; frame < 5; frame++) {
				mock.timers.tick(45);
				oldAgain.render(100);
			}
			const oldAsked = harness.requestRenders() - asked;
			liveAgain.render(100);
			mock.timers.tick(45);
			assert.ok(harness.requestRenders() - asked > oldAsked, "the running row animates");
			harness.handlers.get("tool_execution_end")!({ toolCallId: live, isError: false });
			liveAgain.updateResult({ ...text("x"), isError: false } as never, false);
			const settled = harness.requestRenders();
			for (let frame = 0; frame < 5; frame++) {
				mock.timers.tick(45);
				oldAgain.render(100);
			}
			assert.equal(harness.requestRenders(), settled, "the old call's new row never animates");
		}
		shutdown(harness);
	}
});

test("in a long session, a call an early run left without its result is not revived by a later run", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	const read = (id: string) => makeRow("read", id, { path: `src/${id}.ts` }, harness.definitions.get("read"));
	harness.handlers.get("agent_start")!({});
	announce(harness, "early", "read");
	const early = read("early");
	harness.handlers.get("agent_end")!({ messages: [] });
	// Thousands of calls since, more than any bounded memory of calls would keep.
	for (let run = 0; run < 3; run++) {
		harness.handlers.get("agent_start")!({});
		for (let call = 0; call < 1_000; call++) {
			const id = `later-${run}-${call}`;
			announce(harness, id, "read");
			read(id).updateResult({ ...text("x"), isError: false } as never);
		}
		harness.handlers.get("agent_end")!({ messages: [] });
	}
	harness.handlers.get("agent_start")!({});
	harness.chat.children = [early];
	assert.deepEqual(lines(harness), [" ⦁ Read 1 file (ctrl+o to expand)"]);
	shutdown(harness);
});

test("a call is known from any update that carries it, or from its execution", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	harness.handlers.get("agent_start")!({});
	// An update of any kind carries the message's calls; Pi makes rows from any of them.
	harness.handlers.get("message_update")!({
		message: { role: "assistant", content: [{ type: "text", text: "…" }, { type: "toolCall", id: "from-update", name: "read", arguments: {} }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "…" },
	});
	// A call Pi first hears of as it runs gets its row then.
	harness.handlers.get("tool_execution_start")!({ toolCallId: "from-execution", toolName: "read", args: {} });
	// A user's message, or an update carrying no calls, announces nothing.
	harness.handlers.get("message_update")!({ message: { role: "user", content: [{ type: "toolCall", id: "not-a-call" }] }, assistantMessageEvent: {} });
	for (const [id, expected] of [["from-update", "Reading"], ["from-execution", "Reading"], ["not-a-call", "Read"]] as const) {
		const row = makeRow("read", id, { path: "src/a.ts" }, harness.definitions.get("read"));
		harness.chat.children = [row];
		assert.match(lines(harness)[0]!, new RegExp(`⦁ ${expected} 1 file`, "u"), id);
	}
	shutdown(harness);
});

test("only calls Pi announced in the run going on can run, however many calls came before", () => {
	const runtime = new ToolRuntime();
	assert.equal(runtime.canRun("anything"), true, "until the host says whether the agent works, as before");
	runtime.setBusy(false);
	assert.equal(runtime.canRun("restored"), false, "restored while idle");
	runtime.setBusy(true);
	assert.equal(runtime.canRun("restored"), false, "a run does not revive it");
	runtime.noteCall("old");
	assert.equal(runtime.canRun("old"), true, "announced in this run");
	runtime.setBusy(false);
	assert.equal(runtime.canRun("old"), false, "its run ended without its result");
	// A long session: thousands of calls in later runs.
	for (let run = 0; run < 3; run++) {
		runtime.setBusy(true);
		for (let call = 0; call < 1_000; call++) runtime.noteCall(`later-${run}-${call}`);
		runtime.setBusy(false);
	}
	runtime.setBusy(true);
	assert.equal(runtime.canRun("old"), false, "still not running, however many calls came since");
	assert.equal(runtime.canRun("later-2-999"), false, "nor any call of an earlier run");
	runtime.noteCall("now");
	assert.equal(runtime.canRun("now"), true);
	runtime.setBusy(true);
	assert.equal(runtime.canRun("now"), true, "the same run going on keeps its calls");
	runtime.reset(true);
});

test.after(restoreClocks);
