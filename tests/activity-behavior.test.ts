/**
 * Silent mode's activity line follows the thinking level and the theme on the
 * next frame, and resolves its colors once for each, not on every frame.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	initTheme,
	UserMessageComponent,
	type Theme,
	type ThemeAppearance,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { rgbColor, Spacer, type Color } from "@earendil-works/pi-tui";
import { renderActivityDots } from "../extensions/compact-tools-activity.ts";
import { loadExtension, restoreClocks, shutdown } from "./indicator-harness.ts";
import { theme as piTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const colorsOf = (line: string) => [...line.matchAll(/38;2;([0-9;]+)m━/gu)].map((match) => match[1]);
const silentState = () =>
	(globalThis as Record<symbol, { active: boolean; enabled: boolean }>)[Symbol.for("pi-compact-tools.silent.state")]!;

/** Pi's theme as a palette of its own, with some colors or its appearance overridden and every color lookup counted. */
function variantTheme(overrides: Partial<Record<ThemeColor, Color>>, appearance?: ThemeAppearance) {
	let lookups = 0;
	// A copy: Pi freezes its palette, and a proxy may not answer differently for a frozen property.
	const colors = new Proxy({ ...(piTheme as Theme).colors }, {
		get(target, token) {
			lookups++;
			return overrides[token as ThemeColor] ?? Reflect.get(target, token);
		},
	});
	const theme = new Proxy(piTheme as Theme, {
		get(target, key) {
			if (key === "colors") return colors;
			if (key === "appearance" && appearance) return appearance;
			return Reflect.get(target, key);
		},
	});
	return { theme, lookups: () => lookups };
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

/**
 * Pi compacts between turns and writes the summary straight into the chat, after
 * a spacer of its own. In silent mode that row would land under the prompt the
 * line animates beneath, pushing the line up and away from the editor.
 */
test("a summary Pi writes mid-turn leaves the silent line where it was, at the foot of the chat", async () => {
	initTheme("dark", false);
	const harness = await loadExtension({ style: "compact", mode: "silent" }, { tui: true, idle: false });
	try {
		harness.handlers.get("agent_start")!({});
		const prompt = new UserMessageComponent("Look around");
		harness.chat.children = [prompt];
		// The line attaches to the latest prompt once a render pass settles.
		harness.chat.render(80);
		await Promise.resolve();
		mock.timers.tick(80 * 7);
		const settled = harness.chat.render(80);
		assert.ok(settled.at(-1)?.includes("━"), "the line is the chat's last row");

		for (const summary of [
			new CompactionSummaryMessageComponent({ role: "compactionSummary", tokensBefore: 257_586, summary: "## Goal\nLook around" } as never),
			new BranchSummaryMessageComponent({ role: "branchSummary", summary: "## Goal\nLook around" } as never),
		]) {
			harness.chat.children = [prompt, new Spacer(1), summary];
			assert.deepEqual(harness.chat.render(80), settled, `${summary.constructor.name} and its spacer are hidden`);
		}

		// Out of silent mode the summary is the reader's again, spacer included.
		silentState().enabled = false;
		const visible = harness.chat.render(80);
		assert.ok(visible.length > settled.length, "the summary comes back");
		assert.ok(visible.some((line) => line.includes("[compaction]")) || visible.some((line) => line.includes("Branch summary")));
	} finally {
		silentState().enabled = false;
		shutdown(harness);
	}
});

test("the line's colors are resolved once for a palette and a level, not on every frame", () => {
	const { theme, lookups } = variantTheme({});
	// One whole breath paints every frame once; after that a frame is a lookup.
	for (let frame = 0; frame < 26; frame++) renderActivityDots(frame, 40, theme, "xhigh");
	const warm = lookups();
	assert.ok(warm > 0, "the palette was read to paint the line");
	for (let frame = 26; frame <= 100; frame++) renderActivityDots(frame, 40, theme, "xhigh");
	assert.equal(lookups(), warm, "no frame after the first breath reads a color");
});

test("a palette that changes only the level's color, or only its appearance, repaints the line", () => {
	const draw = (theme: Theme) => colorsOf(renderActivityDots(12, 40, theme, "high")[0]!);
	const base = variantTheme({});
	const plain = draw(base.theme);
	for (const [label, variant] of [
		["thinkingHigh", variantTheme({ thinkingHigh: rgbColor(255, 120, 0) })],
		["appearance", variantTheme({}, "light")],
	] as const) {
		assert.notDeepEqual(draw(variant.theme), plain, `${label} alone`);
		assert.deepEqual(draw(base.theme), plain, `${label}: the unchanged theme draws as before`);
	}
});

test.after(() => {
	initTheme("dark", false);
	restoreClocks();
});
