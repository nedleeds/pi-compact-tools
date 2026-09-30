/**
 * Hand-made themes for unit tests. A test names the few colors it cares about the
 * way Pi writes them, as escape sequences from `getFgAnsi`; this adds what Pi 0.99's
 * Theme offers on top, concrete `colors` and the `appearance` it is designed for, so
 * the same mock exercises both the Pi 0.99 path and, on older Pi, the escape path.
 * Nothing here depends on types only Pi 0.99 has, so the suite runs on every Pi.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";

type Appearance = "dark" | "light";
/** A color the way Pi 0.99 hands it out: the shape its `colorToRgb` reads. */
export type HostColor = { kind: "rgb"; r: number; g: number; b: number } | { kind: "indexed"; index: number };

type ThemeMock = {
	getFgAnsi?: (color: string) => string;
} & Record<string, unknown>;

/** Whether the Pi under test resolves theme colors itself (0.99 and later). */
export const hostResolvesColors = typeof (tui as unknown as { colorToRgb?: unknown }).colorToRgb === "function";

export const rgb = (r: number, g: number, b: number): HostColor => ({ kind: "rgb", r, g, b });

function parseAnsi(ansi: string): HostColor | undefined {
	const trueColor = ansi.match(/\[38;2;(\d+);(\d+);(\d+)m/u);
	if (trueColor) return rgb(Number(trueColor[1]), Number(trueColor[2]), Number(trueColor[3]));
	const indexed = ansi.match(/\[38;5;(\d+)m/u);
	return indexed ? { kind: "indexed", index: Number(indexed[1]) } : undefined;
}

/** A mock's colors, read from its `getFgAnsi` on each access; a color it does not know is absent. */
function colorsOf(mock: ThemeMock): Record<string, HostColor | undefined> {
	return new Proxy({}, {
		get(_target, token) {
			if (typeof token !== "string" || typeof mock.getFgAnsi !== "function") return undefined;
			try {
				return parseAnsi(mock.getFgAnsi(token));
			} catch {
				return undefined;
			}
		},
	});
}

/** Dark unless the mock's text is dark, which is how a theme without a declared appearance is read. */
function appearanceOf(colors: Record<string, HostColor | undefined>): Appearance {
	const text = colors.text;
	if (!text || text.kind !== "rgb") return "dark";
	return text.r * 0.299 + text.g * 0.587 + text.b * 0.114 > 128 ? "dark" : "light";
}

export function fakeTheme(mock: ThemeMock, appearance?: Appearance): Theme {
	const colors = colorsOf(mock);
	return {
		...mock,
		colors,
		get appearance() {
			return appearance ?? appearanceOf(colors);
		},
	} as unknown as Theme;
}
