/** Pure timing and text helpers for compact tool rendering. */

export type RowStatus = "pending" | "running" | "success" | "error";

export type IndicatorTone = "borderAccent" | "border" | "borderMuted" | "success" | "error";

const RUNNING_INDICATOR_STRENGTHS = [1, 0.82, 0.64, 0.46, 0.28, 0.1, 0.28, 0.46, 0.64, 0.82] as const;

export function indicatorStrength(status: RowStatus, frame = 0): number {
	if (status !== "running") return 1;
	return RUNNING_INDICATOR_STRENGTHS[frame % RUNNING_INDICATOR_STRENGTHS.length] ?? 1;
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
