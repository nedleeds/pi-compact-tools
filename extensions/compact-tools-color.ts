import type { Theme } from "@earendil-works/pi-coding-agent";

export type Rgb = { r: number; g: number; b: number };
type ThemeForeground = Parameters<Theme["getFgAnsi"]>[0];

const ANSI_BASIC_RGB: readonly Rgb[] = [
	{ r: 0, g: 0, b: 0 }, { r: 128, g: 0, b: 0 }, { r: 0, g: 128, b: 0 }, { r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 }, { r: 128, g: 0, b: 128 }, { r: 0, g: 128, b: 128 }, { r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 }, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 255 }, { r: 0, g: 255, b: 255 }, { r: 255, g: 255, b: 255 },
];

function ansi256ToRgb(index: number): Rgb {
	if (index < 16) return ANSI_BASIC_RGB[index] ?? { r: 192, g: 192, b: 192 };
	if (index < 232) {
		const value = index - 16;
		const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
		return {
			r: channel(Math.floor(value / 36)),
			g: channel(Math.floor((value % 36) / 6)),
			b: channel(value % 6),
		};
	}
	const gray = 8 + Math.min(23, index - 232) * 10;
	return { r: gray, g: gray, b: gray };
}

const ANSI_256_RGB: readonly Rgb[] = Array.from({ length: 256 }, (_, index) => ansi256ToRgb(index));

/**
 * The nearest-color search runs per character on 256-color terminals, so both the
 * palette and the answers are kept. Callers interpolate between a handful of theme
 * colors, so the memo holds tens of entries rather than growing with output size.
 */
const ansi256ByRgb = new Map<number, number>();

function rgbToAnsi256(rgb: Rgb): number {
	const key = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
	const memoized = ansi256ByRgb.get(key);
	if (memoized !== undefined) return memoized;
	let bestIndex = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < 256; index++) {
		const candidate = ANSI_256_RGB[index]!;
		const distance = (rgb.r - candidate.r) ** 2 + (rgb.g - candidate.g) ** 2 + (rgb.b - candidate.b) ** 2;
		if (distance >= bestDistance) continue;
		bestIndex = index;
		bestDistance = distance;
	}
	ansi256ByRgb.set(key, bestIndex);
	return bestIndex;
}

export function themeColorRgb(theme: Theme, color: ThemeForeground): Rgb | undefined {
	if (typeof theme.getFgAnsi !== "function") return undefined;
	// Pi throws on a color it does not know, and callers reach this with names computed from
	// host state — a thinking level Pi adds later would otherwise take down a render.
	let ansi: string;
	try {
		ansi = theme.getFgAnsi(color);
	} catch {
		return undefined;
	}
	const trueColor = ansi.match(/\[38;2;(\d+);(\d+);(\d+)m/u);
	if (trueColor) return { r: Number(trueColor[1]), g: Number(trueColor[2]), b: Number(trueColor[3]) };
	const indexed = ansi.match(/\[38;5;(\d+)m/u);
	return indexed ? ansi256ToRgb(Number(indexed[1])) : undefined;
}

export function interpolateRgb(from: Rgb, to: Rgb, amount: number): Rgb {
	const bounded = Math.max(0, Math.min(1, amount));
	const channel = (start: number, end: number) => Math.round(start + (end - start) * bounded);
	return {
		r: channel(from.r, to.r),
		g: channel(from.g, to.g),
		b: channel(from.b, to.b),
	};
}

/** Shared by the foreground (38/39) and background (48/49) SGR pairs. */
function paintRgb(theme: Theme, color: Rgb, text: string, set: 38 | 48): string {
	const reset = set === 38 ? 39 : 49;
	if (typeof theme.getColorMode === "function" && theme.getColorMode() === "256color") {
		return `\x1b[${set};5;${rgbToAnsi256(color)}m${text}\x1b[${reset}m`;
	}
	return `\x1b[${set};2;${color.r};${color.g};${color.b}m${text}\x1b[${reset}m`;
}

export function colorizeRgb(theme: Theme, color: Rgb, text: string): string {
	return paintRgb(theme, color, text, 38);
}

/** Perceived brightness on the same 0-255 scale as the channels, and linear under interpolation. */
function luminanceRgb(rgb: Rgb): number {
	return rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
}

function isDarkTheme(theme: Theme): boolean {
	const text = themeColorRgb(theme, "text");
	if (!text) return true;
	return luminanceRgb(text) > 128;
}

/** Themes never expose their terminal background, so the poles stand in for it. */
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Mix a color toward its own gray so a vivid theme hue cannot turn chrome into a highlight. */
export function neutralizeRgb(rgb: Rgb, keepHue: number): Rgb {
	const gray = Math.round(luminanceRgb(rgb));
	return interpolateRgb({ r: gray, g: gray, b: gray }, rgb, keepHue);
}

/**
 * Reach a luminance by scaling every channel, which moves the color along its own ray from
 * black and so leaves hue and saturation untouched — the same color, brighter or darker.
 * Scaling up stops where the first channel would clip; past that only white can add light,
 * and the color washes out the way a real highlight does.
 */
function atBrightness(rgb: Rgb, target: number): Rgb {
	const brightness = luminanceRgb(rgb);
	if (brightness <= 0) return interpolateRgb(BLACK, WHITE, target / 255);
	const headroom = 255 / Math.max(rgb.r, rgb.g, rgb.b, 1);
	const scale = Math.min(target / brightness, headroom);
	const scaled: Rgb = { r: rgb.r * scale, g: rgb.g * scale, b: rgb.b * scale };
	const reached = luminanceRgb(scaled);
	const rounded: Rgb = { r: Math.round(scaled.r), g: Math.round(scaled.g), b: Math.round(scaled.b) };
	return reached >= target - 0.5 ? rounded : interpolateRgb(rounded, WHITE, (target - reached) / (255 - reached));
}

/** Lift a color part of the way to maximum contrast, keeping its hue for as long as it can. */
export function liftContrast(theme: Theme, rgb: Rgb, amount: number): Rgb {
	const dark = isDarkTheme(theme);
	const brightness = luminanceRgb(rgb) / 255;
	const level = dark ? brightness : 1 - brightness;
	const target = level + (1 - level) * amount;
	return atBrightness(rgb, (dark ? target : 1 - target) * 255);
}

/**
 * Move a color until how far it stands off the theme background — 0 for invisible, 1 for
 * the opposite pole — lands inside the band. A color already inside is returned untouched,
 * so a theme's own choice survives wherever it is legible to begin with.
 */
export function withContrast(theme: Theme, rgb: Rgb, minimum: number, maximum: number): Rgb {
	const dark = isDarkTheme(theme);
	const brightness = luminanceRgb(rgb) / 255;
	const level = dark ? brightness : 1 - brightness;
	const target = level > maximum ? maximum : level < minimum ? minimum : level;
	if (target === level) return rgb;
	return atBrightness(rgb, (dark ? target : 1 - target) * 255);
}

/**
 * Diff rows need a tint that reads on the terminal background without hijacking `toolSuccessBg`
 * and `toolErrorBg`, which Pi paints across the whole tool row.
 */
export function diffTintRgb(theme: Theme, color: ThemeForeground, amount = 0.20): Rgb | undefined {
	const rgb = themeColorRgb(theme, color);
	if (!rgb) return undefined;
	const base = isDarkTheme(theme) ? BLACK : WHITE;
	return interpolateRgb(base, rgb, amount);
}

export function fillRgb(theme: Theme, color: Rgb, text: string): string {
	return paintRgb(theme, color, text, 48);
}
