import assert from "node:assert/strict";
import test from "node:test";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { usesNativeChangelog } from "../extensions/compact-tools-release.ts";
import { codexDisclosure } from "../extensions/compact-tools-codex.ts";
import { toolExpandKey, type BuiltInDefinition, type RenderContext } from "../extensions/compact-tools-types.ts";
import { loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

for (const style of ["compact", "claude", "codex"]) test(`${style}: injected expand keys, legacy fallback, unbound action and result cache`, async () => {
	const harness = await loadExtension({ style }, { idle: true });
	try {
		const definition = harness.definitions.get("bash")! as unknown as BuiltInDefinition;
		let key = "alt+e";
		const ctx: RenderContext = {
			args: { command: "seq 20" }, argsComplete: true, cwd: "/project", executionStarted: false,
			expanded: false, invalidate() {}, isError: false, isPartial: false, lastComponent: undefined,
			showImages: false, state: {}, toolCallId: `keys-${style}`,
			keyText(action) { assert.equal(action, "app.tools.expand"); return key; },
			keyHint() { throw new Error("must use raw injected keys, not a separate host singleton"); },
		};
		const value = text(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
		const draw = () => definition.renderResult!(value, { expanded: false, isPartial: false }, theme, ctx as never);
		const plain = (component: ReturnType<typeof draw>, width = 100) => component.render(width).map(stripTerminalSequences).join("\n");
		const first = draw();
		if (style !== "compact") assert.match(plain(first), /alt\+e to expand/u);
		ctx.lastComponent = first;
		assert.equal(draw(), first, "unchanged host keys reuse the existing result");
		key = "ctrl+shift+x";
		const rebound = draw();
		assert.notEqual(rebound, first, "changed keys invalidate the result even when host function identity stays the same");
		if (style !== "compact") assert.match(plain(rebound), /ctrl\+shift\+x to expand/u);
		ctx.lastComponent = rebound;
		key = "";
		const unbound = draw();
		assert.doesNotMatch(plain(unbound), /to expand/u);
		ctx.lastComponent = unbound;
		delete ctx.keyText; delete ctx.keyHint;
		const legacy = draw();
		assert.equal(toolExpandKey(ctx), "ctrl+o");
		if (style === "claude") assert.match(plain(legacy), /ctrl\+o to expand/u);
		for (const component of [first, rebound, unbound, legacy]) for (const width of [1, 3, 12, 30]) {
			assert.ok(component.render(width).every(line => visibleWidth(line) <= width), `fits ${width}`);
		}
	} finally { shutdown(harness); }
});

test("Codex keeps platform spelling only for the default key and fits custom or empty hints", () => {
	assert.match(codexDisclosure(100, false, 4, "alt+e"), /alt\+e to expand/u);
	assert.equal(codexDisclosure(100, false, 4, ""), "     + 4 lines");
	assert.equal(codexDisclosure(20, false, 4, "ctrl+shift+alt+x"), "     + 4 lines");
});
for (const style of ["claude", "codex"]) test(`${style}: real Pi 1.5 rows inject custom app keys`, { skip: !usesNativeChangelog() }, async () => {
	const previous = getKeybindings();
	const harness = await loadExtension({ style }, { idle: true });
	try {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "alt+e" }));
		const row = makeRow("bash", `host-key-${style}`, { command: "seq 20" }, harness.definitions.get("bash"));
		row.updateResult({ ...text(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")), isError: false } as never);
		assert.match(row.render(100).map(stripTerminalSequences).join("\n"), /alt\+e to expand/u);
	} finally { setKeybindings(previous); shutdown(harness); }
});
test.after(restoreClocks);
