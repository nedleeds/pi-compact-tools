/**
 * A row's time is the tool's time: it starts when the tool runs, as Pi times its
 * own rows, not when the model starts writing the call's arguments.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { advance, animate, announce, CASES, elapse, INDICATOR_INTERVAL_MS, loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";
import { mock } from "node:test";

const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/gu, "")).join("\n");
let sequence = 0;

// Claude Code draws no time on a row; its groups show time, tested below.
test("a long-streamed call is timed from when it runs", async () => {
	const harness = await loadExtension({ style: "compact", auto_compact: { write: true } }, { tui: true, idle: false });
	const id = `write-${++sequence}`;
	announce(harness, id, "write");
	const row = makeRow("write", id, {}, harness.definitions.get("write"));
	// The model spends five seconds writing the file's content.
	for (let chunk = 1; chunk <= 5; chunk++) {
		row.updateArgs({ path: "src/big.ts", content: "x\n".repeat(chunk * 100) });
		advance(1_000);
		animate([row], 1, 100, () => {});
	}
	row.setArgsComplete();
	harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "write", args: {} });
	row.markExecutionStarted();
	advance(120);
	harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
	row.updateResult({ ...text("Wrote 500 lines"), isError: false } as never, false);
	const drawn = plain(row.render(100));
	assert.match(drawn, /Done in 0\.120s/u);
	assert.doesNotMatch(drawn, /5\.\d{3}s/u);
	shutdown(harness);
});

test("a call that never ran has no time to show", async () => {
	for (const [name, outcome] of Object.entries(CASES)) {
		const harness = await loadExtension({ style: "compact" }, { tui: true, idle: false });
		const id = `aborted-${++sequence}`;
		announce(harness, id, name);
		const row = makeRow(name, id, {}, harness.definitions.get(name));
		row.updateArgs(outcome.args);
		advance(3_000);
		// Pi fails every call still streaming when the turn is aborted.
		row.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true } as never);
		const drawn = plain(row.render(100));
		// Where the output is previewed it says why; otherwise the status line does.
		assert.match(drawn, /└ Failed( · Operation aborted)?$/mu, name);
		assert.match(drawn, /Operation aborted/u, name);
		assert.doesNotMatch(drawn, / in \d/u, name);
		shutdown(harness);
	}
});

test("a custom tool is timed from when it runs", async () => {
	const harness = await loadExtension({ style: "compact" }, { tui: true, idle: false });
	const id = `custom-${++sequence}`;
	announce(harness, id, "web_search");
	const row = makeRow("web_search", id, {}, undefined);
	row.updateArgs({ query: "pi" });
	advance(4_000);
	row.setArgsComplete();
	harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "web_search", args: {} });
	row.markExecutionStarted();
	advance(345);
	harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
	row.updateResult({ ...text("one\ntwo"), isError: false } as never, false);
	assert.match(plain(row.render(100)), /Done in 0\.345s \(2 lines\)/u);
	shutdown(harness);
});

test("parallel calls are each timed from their own start", async () => {
	const harness = await loadExtension({ style: "compact" }, { tui: true, idle: false });
	const rows = ["read", "grep"].map((name) => {
		const id = `parallel-${++sequence}`;
		announce(harness, id, name);
		const row = makeRow(name, id, CASES[name]!.args, harness.definitions.get(name));
		row.setArgsComplete();
		return { id, row, name };
	});
	const start = ({ id, row, name }: (typeof rows)[number]) => {
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: name, args: {} });
		row.markExecutionStarted();
	};
	const end = ({ id, row, name }: (typeof rows)[number]) => {
		harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
		row.updateResult({ ...CASES[name]!.success, isError: false } as never, false);
	};
	start(rows[0]!);
	advance(1_000);
	start(rows[1]!);
	advance(500);
	end(rows[0]!);
	advance(250);
	end(rows[1]!);
	assert.match(plain(rows[0]!.row.render(100)), /Done in 1\.500s/u);
	assert.match(plain(rows[1]!.row.render(100)), /Done in 0\.750s/u);
	shutdown(harness);
});

test("a Claude group counts the time its running call has run, not how long it was written", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: false });
	const id = `group-${++sequence}`;
	announce(harness, id, "grep");
	const row = makeRow("grep", id, {}, harness.definitions.get("grep"));
	harness.chat.children = [row];
	row.updateArgs({ pattern: "TODO", path: "src" });
	advance(3_000);
	row.setArgsComplete();
	harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "grep", args: {} });
	row.markExecutionStarted();
	const tick = () => {
		elapse(INDICATOR_INTERVAL_MS);
		mock.timers.tick(INDICATOR_INTERVAL_MS);
		return plain(harness.chat.render(100));
	};
	assert.doesNotMatch(tick(), /·/u, "under two seconds of running shows no time");
	advance(2_100);
	assert.match(tick(), /Searching for 1 pattern · 2\.100s…/u);
	shutdown(harness);
});

test.after(restoreClocks);
