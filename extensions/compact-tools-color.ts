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
	const ansi = theme.getFgAnsi(color);
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

function isDarkTheme(theme: Theme): boolean {
	const text = themeColorRgb(theme, "text");
	if (!text) return true;
	return text.r * 0.299 + text.g * 0.587 + text.b * 0.114 > 128;
}

/**
 * Diff rows need a tint that reads on the terminal background without hijacking `toolSuccessBg`
 * and `toolErrorBg`, which Pi paints across the whole tool row.
 */
export function diffTintRgb(theme: Theme, color: ThemeForeground, amount = 0.16): Rgb | undefined {
	const rgb = themeColorRgb(theme, color);
	if (!rgb) return undefined;
	const base: Rgb = isDarkTheme(theme) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
	return interpolateRgb(base, rgb, amount);
}

export function fillRgb(theme: Theme, color: Rgb, text: string): string {
	return paintRgb(theme, color, text, 48);
}
