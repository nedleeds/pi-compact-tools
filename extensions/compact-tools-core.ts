/** Pure timing and text helpers for compact tool rendering. */

export type RowStatus = "pending" | "running" | "success" | "error";

export type IndicatorTone = "borderAccent" | "border" | "borderMuted" | "success" | "error";

export const RUNNING_INDICATOR_FRAME_COUNT = 14;
const RUNNING_INDICATOR_MIN_STRENGTH = 0.08;

export function indicatorStrength(status: RowStatus, frame = 0): number {
	if (status !== "running") return 1;
	const normalizedFrame = ((frame % RUNNING_INDICATOR_FRAME_COUNT) + RUNNING_INDICATOR_FRAME_COUNT)
		% RUNNING_INDICATOR_FRAME_COUNT;
	const wave = (Math.cos((normalizedFrame / RUNNING_INDICATOR_FRAME_COUNT) * Math.PI * 2) + 1) / 2;
	return RUNNING_INDICATOR_MIN_STRENGTH + (1 - RUNNING_INDICATOR_MIN_STRENGTH) * wave;
}

/** Semantic fallback for themes whose foreground RGB values cannot be resolved. */
export function indicatorTone(status: RowStatus, frame = 0): IndicatorTone {
	if (status === "success") return "success";
	if (status === "error") return "error";
	if (status === "pending") return "borderAccent";
	const strength = indicatorStrength(status, frame);
	return strength >= 0.7 ? "borderAccent" : strength >= 0.35 ? "border" : "borderMuted";
}

export function indicatorGlyph(_status: RowStatus, _frame = 0): string {
	return "⦁";
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
