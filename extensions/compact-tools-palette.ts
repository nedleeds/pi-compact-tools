import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	colorizeRgb,
	liftContrast,
	neutralizeRgb,
	themeColorRgb,
	withContrast,
	type Rgb,
} from "./compact-tools-color.ts";

/**
 * Colors this extension draws with, derived from the active theme rather than named on it.
 *
 * Naming a color does not travel. `borderAccent` is a quiet gray in github-dark-pro and
 * electric cyan in Pi's own dark theme; `dim` is the dimmest name a theme offers yet is
 * still sized for body text, a step louder than a rail should be; and a hard-coded white
 * highlight disappears entirely on a light background. So each value here takes a theme
 * color for its hue and then places it: chrome and the indicator give up most of their
 * saturation and are pulled into a fixed contrast band, while the working label keeps its
 * hue exactly and is moved only in brightness. Everything is measured against the theme
 * background, so the same code reads the same way on light and dark alike: against a light
 * background the moves invert, and standing out means going darker.
 */

type ThemeForeground = Parameters<Theme["getFgAnsi"]>[0];

type ContrastBand = { color: ThemeForeground; keepHue: number; minimum: number; maximum: number };

/** A band with no color attached, for a derivation that supplies its own source. */
type ContrastRange = { minimum: number; maximum: number };

/**
 * One tone for the whole frame — rails, the result connector, and the status line it leads
 * to — so the frame reads as a single quiet object rather than competing with the output.
 */
const CHROME: ContrastBand = { color: "dim", keepHue: 0.35, minimum: 0.22, maximum: 0.28 };
/** The indicator breathes either side of the chrome tone, dipping below it and peaking above. */
const PULSE_LOW: ContrastBand = { color: "dim", keepHue: 0.4, minimum: 0.18, maximum: 0.3 };
const PULSE_HIGH: ContrastBand = { color: "muted", keepHue: 0.4, minimum: 0.4, maximum: 0.6 };
/**
 * The working label is painted in the session's own thinking level, the piece of state the
 * row is already reporting on. Themes size those colors for a one-word status chip, so the
 * label takes a brighter shade of the same color and the sweep lifts it again: the row
 * carries the level's hue at a weight that reads across the width of a sentence, and the
 * highlight is that color catching light rather than white laid over it. Both lifts are a
 * share of the light left between the color and full contrast, so a level the theme
 * already paints brightly moves least.
 */
const GLOW_REST_LIFT = 0.3;
const GLOW_CREST_LIFT = 0.72;
/** Themes paint the lowest levels at rail weight; a floor keeps the label off the background. */
const GLOW_FLOOR: ContrastRange = { minimum: 0.4, maximum: 1 };

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const THINKING_LEVEL_COLOR = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const satisfies Record<ThinkingLevel, ThemeForeground>;

/** The theme color a thinking level is painted with. */
function thinkingLevelColor(level: ThinkingLevel): ThemeForeground {
	return THINKING_LEVEL_COLOR[level] ?? "thinkingMedium";
}

/**
 * Derivation is deliberately not cached against the Theme: `/theme` can swap a palette behind
 * the same instance, and a stale entry would outlive the switch. Callers that redraw per line
 * hold the derived value themselves instead.
 */
function bandedRgb(theme: Theme, band: ContrastBand): Rgb | undefined {
	const rgb = themeColorRgb(theme, band.color);
	if (!rgb) return undefined;
	return withContrast(theme, neutralizeRgb(rgb, band.keepHue), band.minimum, band.maximum);
}

/**
 * A chrome painter bound to one theme. Deriving the tone costs a parse and a dozen floating
 * point operations, and the frame is drawn once per line of tool output or thinking detail,
 * so callers in a loop take a painter once and callers with a single rail use `paintChrome`.
 */
export function chromePainter(theme: Theme): (text: string) => string {
	const chrome = bandedRgb(theme, CHROME);
	return chrome ? (text) => colorizeRgb(theme, chrome, text) : (text) => theme.fg("dim", text);
}

/** Paint one rail, connector, or status line in the chrome tone. */
export function paintChrome(theme: Theme, text: string): string {
	return chromePainter(theme)(text);
}

export type ColorRamp = { from: Rgb; to: Rgb };

function ramp(theme: Theme, low: ContrastBand, high: ContrastBand): ColorRamp | undefined {
	const from = bandedRgb(theme, low);
	const to = bandedRgb(theme, high);
	return from && to ? { from, to } : undefined;
}

/** Fade endpoints for the running tool indicator, or undefined when the theme resolves no RGB. */
export function indicatorPulse(theme: Theme): ColorRamp | undefined {
	return ramp(theme, PULSE_LOW, PULSE_HIGH);
}

/** Sweep endpoints for the working label at a thinking level, resting color to crest. */
export function progressGlow(theme: Theme, level: ThinkingLevel): ColorRamp | undefined {
	const raw = themeColorRgb(theme, thinkingLevelColor(level));
	if (!raw) return undefined;
	const lifted = liftContrast(theme, raw, GLOW_REST_LIFT);
	const from = withContrast(theme, lifted, GLOW_FLOOR.minimum, GLOW_FLOOR.maximum);
	return { from, to: liftContrast(theme, from, GLOW_CREST_LIFT) };
}
