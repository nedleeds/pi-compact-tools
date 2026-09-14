/** Pure configuration, timing, text, and color helpers for compact tool rendering. */

const DURATION_INDICATOR_COLORS = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "toolTitle", "toolOutput", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "bashMode",
] as const;

export type ThemeDurationIndicatorColor = (typeof DURATION_INDICATOR_COLORS)[number];
export type DurationIndicatorColor = ThemeDurationIndicatorColor | `#${string}`;
export type DurationIndicatorConfig = {
	underMs?: number;
	icon: string;
	color?: DurationIndicatorColor;
};
export type RowStatus = "pending" | "running" | "success" | "error";
export type ExpandableLevelState = {
	level?: number;
	levels: readonly number[];
};

export function shouldExpandAll(rows: readonly ExpandableLevelState[]): boolean {
	return rows.some(({ level, levels }) => level !== levels.at(-1));
}

const DURATION_INDICATOR_COLOR_SET = new Set<string>(DURATION_INDICATOR_COLORS);
export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

export function parseDurationIndicators(value: unknown): DurationIndicatorConfig[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const rules: DurationIndicatorConfig[] = [];
	let previousLimit = 0;
	for (const [index, item] of value.entries()) {
		if (!isObject(item) || typeof item.icon !== "string" || item.icon.length === 0) return undefined;
		if (
			item.color !== undefined &&
			(typeof item.color !== "string" ||
				(!DURATION_INDICATOR_COLOR_SET.has(item.color) && !HEX_COLOR_PATTERN.test(item.color)))
		) return undefined;
		const color = item.color as DurationIndicatorColor | undefined;
		const isLast = index === value.length - 1;
		if (isLast && item.underMs === undefined) rules.push({ icon: item.icon, color });
		else if (isPositiveInteger(item.underMs, previousLimit + 1)) {
			previousLimit = item.underMs;
			rules.push({ underMs: item.underMs, icon: item.icon, color });
		} else return undefined;
	}
	return rules.at(-1)?.underMs === undefined ? rules : undefined;
}

export function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?|\n/g, "\n");
}


export function classifyCallStatus(isError: boolean, executionStarted: boolean, completed: boolean): RowStatus {
	if (isError) return "error";
	if (completed) return "success";
	return executionStarted ? "running" : "pending";
}

export function formatDurationMs(elapsedMs: number): string {
	return `${(elapsedMs / 1000).toFixed(3)}s`;
}

export function selectDurationIndicator(
	rules: readonly DurationIndicatorConfig[],
	elapsedMs: number | undefined,
): DurationIndicatorConfig | undefined {
	if (elapsedMs === undefined) return rules[0];
	return rules.find((rule) => rule.underMs === undefined || elapsedMs < rule.underMs);
}

function colorDistanceSquared(red: number, green: number, blue: number, candidate: readonly number[]): number {
	return (red - candidate[0]!) ** 2 + (green - candidate[1]!) ** 2 + (blue - candidate[2]!) ** 2;
}

export function rgbToAnsi256(red: number, green: number, blue: number): number {
	const cube = [red, green, blue].map((channel) => Math.round(channel / 51));
	const cubeRgb = cube.map((channel) => channel * 51);
	const cubeIndex = 16 + 36 * cube[0]! + 6 * cube[1]! + cube[2]!;
	const average = (red + green + blue) / 3;
	const grayStep = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
	const grayLevel = 8 + grayStep * 10;
	const grayRgb = [grayLevel, grayLevel, grayLevel];
	return colorDistanceSquared(red, green, blue, grayRgb) < colorDistanceSquared(red, green, blue, cubeRgb)
		? 232 + grayStep
		: cubeIndex;
}
