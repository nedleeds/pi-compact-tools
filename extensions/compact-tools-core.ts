/** Pure timing and text helpers for compact tool rendering. */

export type RowStatus = "pending" | "running" | "success" | "error";

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
