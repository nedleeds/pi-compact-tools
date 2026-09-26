/**
 * Golden Claude-style groups: a transcript that grows the way Pi grows it, drawn
 * after every change and on every animation frame, so a change to how groups are
 * built or cached cannot change what they draw. Rerun with UPDATE_GOLDEN=1 only
 * when a change to the output is intended.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { advance, announce, elapse, INDICATOR_INTERVAL_MS, loadExtension, makeRow, readable, restoreClocks, shutdown, text, type Harness } from "./indicator-harness.ts";
import { mock } from "node:test";

const GOLDEN_PATH = join(import.meta.dirname, "golden", "groups.json");
const updating = process.env.UPDATE_GOLDEN === "1";
const golden: Record<string, string[][]> = existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) : {};
const recorded: Record<string, string[][]> = {};

function check(key: string, frames: string[][]): void {
	const value = frames.map((frame) => frame.map(readable));
	recorded[key] = value;
	if (updating) return;
	assert.ok(key in golden, `no golden groups for ${key}; rerun with UPDATE_GOLDEN=1 to record it`);
	assert.deepEqual(value, golden[key], key);
}

const thinking = (label: string) => new AssistantMessageComponent({
	content: [{ type: "thinking", thinking: label }, { type: "toolCall", id: label, name: "read", arguments: {} }],
	stopReason: "toolUse",
} as never);
const answer = (words: string) => new AssistantMessageComponent({ content: [{ type: "text", text: words }], stopReason: "stop" } as never);

type Row = ReturnType<typeof makeRow>;

/** Drives a transcript as Pi does, recording the chat after each step. */
export class Transcript {
	readonly frames: string[][] = [];
	private sequence = 0;

	constructor(readonly harness: Harness, readonly width: number, readonly label: string) {
		harness.chat.children = [];
	}

	add(child: unknown): void {
		this.harness.chat.children.push(child);
	}

	snap(): void {
		this.frames.push(this.harness.chat.render(this.width));
	}

	/** Advance the animation, drawing each frame the way Pi's frame requests would. */
	tick(frames: number): void {
		for (let frame = 0; frame < frames; frame++) {
			elapse(INDICATOR_INTERVAL_MS);
			mock.timers.tick(INDICATOR_INTERVAL_MS);
			this.snap();
		}
	}

	stream(name: string): Row {
		const id = `${this.label}-${name}-${++this.sequence}`;
		announce(this.harness, id, name);
		const row = makeRow(name, id, {}, this.harness.definitions.get(name));
		this.add(row);
		return row;
	}

	start(row: Row, args: object): void {
		row.updateArgs(args);
		row.setArgsComplete();
		this.harness.handlers.get("tool_execution_start")?.({ toolCallId: idOf(row), toolName: nameOf(row), args });
		row.markExecutionStarted();
	}

	finish(row: Row, output: string, isError = false): void {
		this.harness.handlers.get("tool_execution_end")?.({ toolCallId: idOf(row), isError });
		row.updateResult({ ...text(output), isError } as never, false);
	}

	/** A left click on the first line that reads like a group's summary. */
	clickGroup(pattern: RegExp): void {
		const lines = this.harness.chat.render(this.width);
		const y = lines.findIndex((line) => pattern.test(line.replace(/\x1b\[[0-9;]*m/gu, "")));
		assert.ok(y >= 0, `a group line matching ${pattern}`);
		const handled = (this.harness.chat as unknown as { handleMouse(event: object): { handled?: boolean } | undefined })
			.handleMouse({ type: "click", button: "left", x: 2, y, width: this.width, height: lines.length });
		this.frames.push([`click ${pattern}: ${handled?.handled === true}`]);
	}

	expandAll(expanded: boolean): void {
		for (const child of this.harness.chat.children) {
			if (typeof (child as Row).setExpanded === "function" && "toolCallId" in (child as object)) (child as Row).setExpanded(expanded);
		}
	}
}

const idOf = (row: Row) => (row as unknown as { toolCallId: string }).toolCallId;
const nameOf = (row: Row) => (row as unknown as { toolName: string }).toolName;

/** The whole story: groups forming as calls stream, run, fail, and settle, then read back. */
export function story(t: Transcript): void {
	t.add(thinking("Looking around"));
	const read = t.stream("read");
	t.snap();
	read.updateArgs({ path: "src/a" });
	t.snap();
	t.tick(3);
	t.start(read, { path: "src/app.ts" });
	t.snap();
	t.tick(3);
	const grep = t.stream("grep");
	t.snap();
	t.start(grep, { pattern: "TODO", path: "src" });
	advance(2_500);
	t.tick(2);
	t.finish(read, "a\nb");
	t.snap();
	t.tick(2);
	t.finish(grep, "rg: bad regex", true);
	t.snap();
	t.add(thinking("More"));
	const ls = t.stream("ls");
	t.start(ls, { path: "src" });
	t.tick(2);
	advance(300);
	t.finish(ls, "a.ts\nb.ts");
	t.snap();
	const again = t.stream("read");
	t.start(again, { path: "src/app.ts" });
	t.finish(again, "a\nb");
	t.snap();
	const build = t.stream("bash");
	t.start(build, { command: "npm test" });
	t.tick(2);
	t.finish(build, "ok");
	t.snap();
	const cat = t.stream("bash");
	t.start(cat, { command: "cat README.md | head -5" });
	t.finish(cat, "readme");
	t.add(answer("All done."));
	t.snap();
	t.tick(2);
	t.clickGroup(/Read 1 file|Searched for/u);
	t.snap();
	t.clickGroup(/Searched for|Read 1 file/u);
	t.snap();
	t.expandAll(true);
	t.snap();
	t.expandAll(false);
	t.snap();
}

for (const width of [100, 44]) {
	test(`group golden: a transcript's groups at width ${width}`, async () => {
		const harness = await loadExtension({ style: "claude" }, { tui: true, idle: false });
		const t = new Transcript(harness, width, `story-${width}`);
		story(t);
		// A new width reflows every group line.
		t.frames.push(harness.chat.render(width === 100 ? 60 : 100));
		t.snap();
		// A theme change repaints them, as Pi invalidates its whole interface.
		initTheme("light", false);
		try {
			(harness.chat as unknown as Component).invalidate?.();
			t.snap();
		} finally {
			initTheme("dark", false);
			(harness.chat as unknown as Component).invalidate?.();
		}
		t.snap();
		check(`story/${width}`, t.frames);
		shutdown(harness);
	});
}

test("group golden: nothing recorded is missing and nothing extra is left behind", () => {
	if (updating) {
		writeFileSync(GOLDEN_PATH, `${JSON.stringify(recorded, null, "\t")}\n`);
		return;
	}
	assert.deepEqual(Object.keys(golden).filter((key) => !(key in recorded)), []);
});

test.after(restoreClocks);
