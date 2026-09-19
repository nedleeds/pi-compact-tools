/** Pure timing and text helpers for compact tool rendering. */

export type RowStatus = "pending" | "running" | "success" | "error";

export type IndicatorTone = "borderAccent" | "border" | "borderMuted" | "success" | "error";

const RUNNING_INDICATOR_TONES: readonly (IndicatorTone | undefined)[] = [
	"borderAccent",
	"border",
	"borderMuted",
	undefined,
	"borderMuted",
	"border",
];

export function indicatorTone(status: RowStatus, frame = 0): IndicatorTone | undefined {
	if (status === "success") return "success";
	if (status === "error") return "error";
	if (status === "pending") return "borderAccent";
	return RUNNING_INDICATOR_TONES[frame % RUNNING_INDICATOR_TONES.length];
}

export function indicatorGlyph(status: RowStatus, frame = 0): string {
	return indicatorTone(status, frame) ? "⦁" : " ";
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
