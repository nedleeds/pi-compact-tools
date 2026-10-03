/**
 * However narrow the pane, no style draws a row past its edge: every built-in and
 * custom tool, finished or failed, collapsed or opened, at every width from one
 * column up. Chrome has a width of its own, so the narrowest panes cut it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { announce, CASES, CUSTOM_CASES, loadExtension, makeRow, restoreClocks, shutdown, type Case } from "./indicator-harness.ts";

const CALLS: Record<string, Case & { author?: object }> = { ...CASES, ...CUSTOM_CASES };

for (const style of ["compact", "claude", "codex"] as const) {
	test(`no ${style} row runs past the edge of a narrow pane`, async () => {
		const harness = await loadExtension({ style }, { tui: true, idle: true });
		try {
			for (const [key, outcome] of Object.entries(CALLS)) {
				const name = key.split("@")[0]!;
				for (const failed of [false, true]) {
					for (const expanded of [false, true]) {
						const id = `${style}-${key}-${failed}-${expanded}`;
						announce(harness, id, name);
						const definition = harness.definitions.get(name) ?? (outcome.author ? { name, ...outcome.author } : undefined);
						const row = makeRow(name, id, outcome.args, definition);
						row.setExpanded(expanded);
						row.updateResult({ ...(failed ? outcome.failure : outcome.success), isError: failed } as never, false);
						for (let width = 1; width <= 16; width++) {
							for (const line of row.render(width)) {
								assert.ok(visibleWidth(line) <= width,
									`${key} ${failed ? "failed" : "done"} ${expanded ? "open" : "closed"} at ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
							}
						}
					}
				}
			}
		} finally { shutdown(harness); }
	});
}

test.after(restoreClocks);
