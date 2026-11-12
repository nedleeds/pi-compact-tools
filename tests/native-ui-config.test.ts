import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../extensions/compact-tools-config.ts";

test("native UI switches default to upstream behavior and merge independently", () => {
	assert.equal(DEFAULT_CONFIG.thinking, true);
	assert.equal(DEFAULT_CONFIG.working, true);
	const global = mergeConfig(DEFAULT_CONFIG, { thinking: false, working: false }, "global");
	assert.equal(global.thinking, false);
	assert.equal(global.working, false);
	const project = mergeConfig(global, { working: true }, "project");
	assert.equal(project.thinking, false);
	assert.equal(project.working, true);
	assert.deepEqual(mergeConfig(project, {}, "project"), project);
});

test("invalid native UI switches warn and preserve previous booleans", (t) => {
	const warning = t.mock.method(console, "error", () => {});
	const base = mergeConfig(DEFAULT_CONFIG, { thinking: false, working: false }, "global");
	for (const invalid of [null, "false", 0, [], {}]) {
		const result = mergeConfig(base, { thinking: invalid, working: invalid }, "project");
		assert.equal(result.thinking, false);
		assert.equal(result.working, false);
	}
	assert.equal(warning.mock.calls.length, 10);
});
