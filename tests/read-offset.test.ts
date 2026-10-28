import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { readStartLine } from "../extensions/compact-tools-invocation.ts";
import { loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";

const CASES: Array<[unknown, number]> = [[11, 11], ["11", 11], [" 11 ", 11], [null, 1], [undefined, 1], ["", 1], ["  ", 1], ["abc", 1], [NaN, 1], [Infinity, 1], [false, 1], [{}, 1]];
test("read offsets normalize historical numbers/strings, not null or malformed values", () => {
	for (const [value, expected] of CASES) assert.equal(readStartLine(value), expected);
});
for (const style of ["compact", "claude"]) test(`${style}: expanded native rows render replayed read arguments correctly`, async () => {
	const harness = await loadExtension({ style }, { idle: true });
	try {
		for (const [offset, start] of CASES) {
			const row = makeRow("read", `read-${style}-${String(offset)}`, { path: "sample.ts", offset, limit: 2 }, harness.definitions.get("read"));
			row.updateResult({ ...text("const first = 1;\nconst second = 2;"), isError: false } as never);
			row.setExpanded(true);
			const output = row.render(100).map(stripTerminalSequences).join("\n");
			if (style === "claude") {
				// Claude's transcript keeps Read counts-only, including restored calls.
				assert.match(output, /Read 2 lines/u);
				assert.doesNotMatch(output, /const (first|second)/u);
				const valid = offset == null || (typeof offset === "number" && Number.isSafeInteger(offset) && offset > 0);
				assert.ok(output.includes(valid ? `Read(sample.ts · lines ${start}-${start + 1})` : "Read(sample.ts)"));
			} else {
				assert.match(output, new RegExp(`\\b${start} const first = 1;`));
				assert.match(output, new RegExp(`\\b${start + 1} const second = 2;`));
			}
		}
	} finally { shutdown(harness); }
});
test.after(restoreClocks);
