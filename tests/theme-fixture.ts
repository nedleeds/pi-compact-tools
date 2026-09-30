/**
 * Hand-made themes for unit tests. A test names the few colors it cares about the
 * way Pi writes them, as escape sequences from `getFgAnsi`; this gives such a mock
 * what the extension's color math reads from Pi's Theme: concrete `colors`, the
 * `appearance` it is designed for, and `style()`.
 */
import type { Theme, ThemeAppearance } from "@earendil-works/pi-coding-agent";
import { indexedColor, rgbColor, styleText, type Color, type TerminalColorMode } from "@earendil-works/pi-tui";

type ThemeMock = {
	getFgAnsi?: (color: string) => string;
	getColorMode?: () => string;
} & Record<string, unknown>;

function parseAnsi(ansi: string): Color | undefined {
	const trueColor = ansi.match(/\[38;2;(\d+);(\d+);(\d+)m/u);
	if (trueColor) return rgbColor(Number(trueColor[1]), Number(trueColor[2]), Number(trueColor[3]));
	const indexed = ansi.match(/\[38;5;(\d+)m/u);
	return indexed ? indexedColor(Number(indexed[1])) : undefined;
}

/** A mock's colors, read from its `getFgAnsi` on each access; a color it does not know is absent. */
function colorsOf(mock: ThemeMock): Record<string, Color | undefined> {
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
function appearanceOf(colors: Record<string, Color | undefined>): ThemeAppearance {
	const text = colors.text;
	if (!text || text.kind !== "rgb") return "dark";
	return text.r * 0.299 + text.g * 0.587 + text.b * 0.114 > 128 ? "dark" : "light";
}

export function fakeTheme(mock: ThemeMock, appearance?: ThemeAppearance): Theme {
	const colors = colorsOf(mock);
	const mode = (mock.getColorMode?.() ?? "truecolor") as TerminalColorMode;
	return {
		style: (text: string, options: { fg?: Color; bg?: Color }) => styleText(text, options, mode),
		...mock,
		colors,
		get appearance() {
			return appearance ?? appearanceOf(colors);
		},
	} as unknown as Theme;
}
