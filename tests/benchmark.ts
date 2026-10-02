/** Run with: npx tsx tests/benchmark.ts <clean baseline directory>. Not a timing-sensitive unit test. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findAnchorTop } from "../extensions/compact-tools-viewport.ts";
import { loadConfig } from "../extensions/compact-tools-config.ts";
import { renderCodeView } from "../extensions/compact-tools-layout.ts";

assert.ok(process.argv[2], "pass a clean baseline directory with the same host dependencies");
const baseline = resolve(process.argv[2]);
const oldViewport = await import(pathToFileURL(join(baseline, "extensions/compact-tools-viewport.ts")).href);
const oldConfig = await import(pathToFileURL(join(baseline, "extensions/compact-tools-config.ts")).href);
const oldLayout = await import(pathToFileURL(join(baseline, "extensions/compact-tools-layout.ts")).href);
const output: Array<{ scenario: string; iterations: number; baselineMs: number; updatedMs: number; improvementPercent: number }> = [];
function compare(scenario: string, iterations: number, before: () => unknown, after: () => unknown): void {
	const measure = (run: () => unknown) => {
		const start = performance.now();
		for (let index = 0; index < iterations; index++) run();
		return performance.now() - start;
	};
	for (let warmup = 0; warmup < 3; warmup++) { measure(before); measure(after); }
	const oldSamples: number[] = [], newSamples: number[] = [];
	for (let sample = 0; sample < 9; sample++) {
		if (sample % 2) { newSamples.push(measure(after)); oldSamples.push(measure(before)); }
		else { oldSamples.push(measure(before)); newSamples.push(measure(after)); }
	}
	const median = (values: number[]) => values.sort((a, b) => a - b)[4]!;
	const baselineMs = median(oldSamples), updatedMs = median(newSamples);
	output.push({ scenario, iterations, baselineMs, updatedMs, improvementPercent: 100 * (1 - updatedMs / baselineMs) });
}
const transcript = Array.from({ length: 20_000 }, (_, index) => `source line ${index}`);
const changed = ["new 1", "new 2", ...transcript];
for (const [scenario, after] of [["viewport: surviving anchor", changed], ["viewport: no surviving anchor", ["unrelated"]]] as const) {
	compare(scenario, 50, () => oldViewport.findAnchorTop(transcript, 19_000, 40, after), () => findAnchorTop(transcript, 19_000, 40, after));
}
const directory = mkdtempSync(join(tmpdir(), "compact-tools-benchmark-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
try {
	compare("config: no file", 1_000, () => oldConfig.loadConfig(), () => loadConfig());
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ style: "compact", previewLines: 10 }));
	compare("config: existing file", 1_000, () => oldConfig.loadConfig(), () => loadConfig());
} finally {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	rmSync(directory, { recursive: true, force: true });
}
const theme = { fg: (_color: string, text: string) => text } as Parameters<typeof renderCodeView>[2];
const source = Array(5_000).fill("plain content").join("\n");
compare("code view: 5,000 lines, construct + render", 10,
	() => oldLayout.renderCodeView(source, "NOTES", theme, { rail: "" }).render(80),
	() => renderCodeView(source, "NOTES", theme, { rail: "" })!.render(80));
console.log(JSON.stringify({ node: process.version, samples: 9, statistic: "median, alternating order, 3 warmups", results: output }, null, 2));
