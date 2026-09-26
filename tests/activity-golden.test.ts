/**
 * Golden silent-mode activity lines: every frame of one breath, at every thinking
 * level, in the dark and the light theme. A theme is drawn right, before and after
 * a switch to another, only if its frames match the ones recorded for it alone.
 * Record one theme per process, the first theme a process draws, with
 * UPDATE_GOLDEN=1 ACTIVITY_THEME=dark (or light), only when a change to the
 * output is intended.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderActivityDots } from "../extensions/compact-tools-activity.ts";
import { readable } from "./indicator-harness.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const THEMES = ["dark", "light"] as const;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const BREATH_FRAMES = 26;
const goldenPath = (name: string) => join(import.meta.dirname, "golden", `activity-${name}.json`);

function draw(name: (typeof THEMES)[number]): Record<string, string[]> {
	initTheme(name, false);
	const frames: Record<string, string[]> = {};
	for (const level of LEVELS) {
		frames[level] = Array.from({ length: BREATH_FRAMES },
			(_, frame) => readable(renderActivityDots(frame, 40, theme as never, level)[0]!));
	}
	return frames;
}

const recording = process.env.UPDATE_GOLDEN === "1" ? process.env.ACTIVITY_THEME as (typeof THEMES)[number] | undefined : undefined;

if (recording) {
	test(`activity golden: record ${recording}`, () => {
		assert.ok(THEMES.includes(recording), "ACTIVITY_THEME is dark or light");
		writeFileSync(goldenPath(recording), `${JSON.stringify(draw(recording), null, "\t")}\n`);
	});
} else {
	test("activity golden: each theme draws its own colors, whichever theme came before it", () => {
		const golden: Record<(typeof THEMES)[number], Record<string, string[]>> = Object.fromEntries(THEMES.map((name) => {
			assert.ok(existsSync(goldenPath(name)), `no golden activity for ${name}`);
			return [name, JSON.parse(readFileSync(goldenPath(name), "utf8")) as Record<string, string[]>] as const;
		})) as Record<(typeof THEMES)[number], Record<string, string[]>>;
		assert.notDeepEqual(golden.dark, golden.light, "the two themes draw different colors");
		// Back and forth, as a user switching /theme would.
		for (const name of ["dark", "light", "dark", "light", "dark"] as const) {
			assert.deepEqual(draw(name), golden[name], `${name} after a switch`);
		}
		for (const level of LEVELS.slice(1)) {
			assert.notDeepEqual(golden.dark[level], golden.dark.off, `${level} has its own color`);
		}
	});
}

test.after(() => initTheme("dark", false));
