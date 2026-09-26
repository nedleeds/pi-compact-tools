/**
 * Silent mode's activity line follows the thinking level and the theme on the
 * next frame, and resolves its colors once for each, not on every frame.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { initTheme, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { renderActivityDots } from "../extensions/compact-tools-activity.ts";
import { loadExtension, restoreClocks, shutdown } from "./indicator-harness.ts";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const colorsOf = (line: string) => [...line.matchAll(/38;2;([0-9;]+)m━/gu)].map((match) => match[1]);
const silentState = () =>
	(globalThis as Record<symbol, { active: boolean; enabled: boolean }>)[Symbol.for("pi-compact-tools.silent.state")]!;

/** Pi's theme, with some colors overridden and every color lookup counted. */
function variantTheme(overrides: Record<string, string>) {
	let lookups = 0;
	const theme = new Proxy(piTheme as Theme, {
		get(target, key, receiver) {
			if (key === "getFgAnsi") {
				return (color: string) => {
					lookups++;
					return overrides[color] ?? (target as Theme).getFgAnsi(color as never);
				};
			}
			return Reflect.get(target, key, receiver);
		},
	});
	return { theme, lookups: () => lookups, overrides };
}

test("the line under a silent prompt follows the thinking level and the theme on the next frame", async () => {
	initTheme("dark", false);
	const harness = await loadExtension({ style: "compact", mode: "silent" }, { tui: true, idle: false });
	try {
		harness.handlers.get("agent_start")!({});
		harness.chat.children = [new UserMessageComponent("Look around")];
		// The line attaches to the latest prompt once a render pass settles.
		harness.chat.render(80);
		await Promise.resolve();
		const activity = () => harness.chat.render(80).find((line) => line.includes("━")) ?? "";
		/** One whole breath: the light is back where it was, so only its color can differ. */
		const breath = () => mock.timers.tick(80 * 26);
		mock.timers.tick(80 * 7);
		const medium = activity();
		assert.ok(colorsOf(medium).length > 0, "the line is drawn");

		harness.setThinkingLevel("high");
		breath();
		const high = activity();
		assert.equal(colorsOf(high).length, colorsOf(medium).length, "the light is where it was");
		assert.notDeepEqual(colorsOf(high), colorsOf(medium), "high is painted in its own color");
		harness.setThinkingLevel("medium");
		breath();
		assert.equal(activity(), medium, "and medium comes back exactly");

		// A theme is read as the line is drawn: no frame has to pass.
		initTheme("light", false);
		const light = activity();
		assert.notDeepEqual(colorsOf(light), colorsOf(medium), "a new theme repaints the line");
		initTheme("dark", false);
		assert.equal(activity(), medium, "and the old theme comes back exactly");
	} finally {
		initTheme("dark", false);
		silentState().enabled = false;
		shutdown(harness);
	}
});

test("the line's colors are resolved once for a theme and a level, not on every frame", () => {
	const { theme, lookups } = variantTheme({});
	renderActivityDots(0, 40, theme, "xhigh");
	const warm = lookups();
	for (let frame = 1; frame <= 50; frame++) renderActivityDots(frame, 40, theme, "xhigh");
	// Each frame reads the two colors the cached ramp was made from, and nothing more.
	assert.equal((lookups() - warm) / 50, 2);
});

test("a theme that changes only the level's color, or only the text's, repaints the line", () => {
	const draw = (theme: Theme) => colorsOf(renderActivityDots(12, 40, theme, "high")[0]!);
	const base = variantTheme({});
	const plain = draw(base.theme);
	for (const [color, ansi] of [["thinkingHigh", "\x1b[38;2;255;120;0m"], ["text", "\x1b[38;2;40;40;40m"]] as const) {
		const variant = variantTheme({ [color]: ansi });
		const changed = draw(variant.theme);
		assert.notDeepEqual(changed, plain, `${color} alone`);
		assert.deepEqual(draw(base.theme), plain, `${color}: the unchanged theme draws as before`);
	}
});

test.after(() => {
	initTheme("dark", false);
	restoreClocks();
});
