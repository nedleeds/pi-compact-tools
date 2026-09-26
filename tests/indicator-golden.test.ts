/**
 * Golden lifecycles: every row driven through Pi's own ToolExecutionComponent in
 * the order Pi drives it, with the running dot recorded on every animation frame.
 * These pin what a live row draws from its first streamed argument to its result,
 * so a change to how the dot is animated cannot change what is drawn. Rerun with
 * UPDATE_GOLDEN=1 only when a change to the output is intended.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	advance, animate, CASES, CUSTOM_CASES, lifecycle, loadExtension, makeRow, MODE_CONFIGS, readable, restoreClocks, shutdown,
} from "./indicator-harness.ts";

const GOLDEN_PATH = join(import.meta.dirname, "golden", "indicator.json");

function loadGolden(): Record<string, string[][]> {
	return existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) : {};
}

const recorded: Record<string, string[][]> = {};
const golden = loadGolden();
const updating = process.env.UPDATE_GOLDEN === "1";

function check(key: string, frames: string[][]): void {
	const value = frames.map((frame) => frame.map(readable));
	recorded[key] = value;
	if (updating) return;
	assert.ok(key in golden, `no golden lifecycle for ${key}; rerun with UPDATE_GOLDEN=1 to record it`);
	assert.deepEqual(value, golden[key], key);
}

let sequence = 0;

for (const [mode, config] of Object.entries(MODE_CONFIGS)) {
	test(`indicator golden: built-in lifecycles in ${mode} mode`, async () => {
		for (const [name, outcome] of Object.entries(CASES)) {
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					for (const width of [100, 44]) {
						const harness = await loadExtension(config);
						const frames = lifecycle(harness, name, `live-${++sequence}`, harness.definitions.get(name), outcome, failed, expanded, width);
						check(`${mode}/${name}/${failed ? "failed" : "done"}/${expanded ? "open" : "closed"}/${width}`, frames);
						shutdown(harness);
					}
				}
			}
		}
	});

	test(`indicator golden: custom tool lifecycles in ${mode} mode`, async () => {
		for (const [key, outcome] of Object.entries(CUSTOM_CASES)) {
			const name = key.split("@")[0]!;
			for (const failed of [false, true]) {
				for (const expanded of [false, true]) {
					const harness = await loadExtension(config);
					const author = outcome.author ? { name, ...outcome.author } : undefined;
					const frames = lifecycle(harness, name, `custom-${++sequence}`, author, outcome, failed, expanded, 100);
					check(`${mode}/custom:${key}/${failed ? "failed" : "done"}/${expanded ? "open" : "closed"}/100`, frames);
					shutdown(harness);
				}
			}
		}
	});

	test(`indicator golden: parallel rows pulse together in ${mode} mode`, async () => {
		const harness = await loadExtension(config);
		const rows = ["read", "grep", "bash"].map((name) => {
			const id = `parallel-${++sequence}`;
			const row = makeRow(name, id, CASES[name]!.args, harness.definitions.get(name));
			row.setArgsComplete();
			harness.handlers.get("tool_execution_start")?.({ toolCallId: id, toolName: name, args: CASES[name]!.args });
			row.markExecutionStarted();
			return row;
		});
		const frames: string[][] = [];
		animate(rows, 4, 100, (frame) => frames.push(frame));
		// The first finishes; the others keep pulsing on the shared frame.
		advance(500);
		harness.handlers.get("tool_execution_end")?.({ toolCallId: (rows[0] as unknown as { toolCallId: string }).toolCallId, isError: false });
		rows[0]!.updateResult({ ...CASES.read!.success, isError: false } as never, false);
		animate(rows, 4, 100, (frame) => frames.push(frame));
		check(`${mode}/parallel`, frames);
		shutdown(harness);
	});

	test(`indicator golden: a click on a running call toggles it in ${mode} mode`, async () => {
		const harness = await loadExtension(config);
		const id = `click-${++sequence}`;
		const row = makeRow("bash", id, CASES.bash!.args, harness.definitions.get("bash"));
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")?.({ toolCallId: id, toolName: "bash", args: CASES.bash!.args });
		row.markExecutionStarted();
		row.updateResult({ ...CASES.bash!.partial!, isError: false } as never, true);
		const frames: string[][] = [row.render(100)];
		const click = { type: "click", button: "left", x: 3, y: 1, width: 100, height: frames[0]!.length };
		const handled = row.handleMouse(click as never);
		frames.push([`handled: ${JSON.stringify(handled ?? null)}`, `expanded: ${(row as unknown as { expanded: boolean }).expanded}`]);
		animate([row], 2, 100, (frame) => frames.push(frame));
		check(`${mode}/click`, frames);
		shutdown(harness);
	});
}

test("indicator golden: nothing recorded is missing and nothing extra is left behind", () => {
	if (updating) {
		writeFileSync(GOLDEN_PATH, `${JSON.stringify(recorded, null, "\t")}\n`);
		return;
	}
	assert.deepEqual(Object.keys(golden).filter((key) => !(key in recorded)), [], "golden lifecycles no test produces any more");
});

test.after(restoreClocks);
