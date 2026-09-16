import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

function pathFrom(args: ToolArgs): string {
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? normalizeLineEndings(value) : "";
}

const INLINE_ARGUMENT_TOOLS = new Set(["grep", "find", "ls"]);

function omitArgument(name: string, key: string): boolean {
	if (key === "path" || key === "file_path") return true;
	if (name === "read" && (key === "offset" || key === "limit")) return true;
	if (name === "write" && key === "content") return true;
	return (name === "grep" || name === "find") && key === "pattern";
}

function collectArgumentDetails(name: string, args: ToolArgs): ToolArgs {
	const details: ToolArgs = {};
	for (const [key, value] of Object.entries(args)) {
		if (value !== undefined && !omitArgument(name, key)) details[key] = value;
	}
	return details;
}

export function getCallDetails(name: string, args: ToolArgs): string {
	const path = pathFrom(args) || (INLINE_ARGUMENT_TOOLS.has(name) ? "." : "");
	if (name === "read") return path;
	if (name !== "grep" && name !== "find") return path;
	const pattern = typeof args.pattern === "string" ? normalizeLineEndings(args.pattern) : "…";
	return name === "grep" ? `/${pattern}/ in ${path}` : `${pattern} in ${path}`;
}

export function getArgumentDetails(name: string, args: ToolArgs): ToolArgs {
	if (name === "edit" || INLINE_ARGUMENT_TOOLS.has(name)) return {};
	return collectArgumentDetails(name, args);
}

export function getTextResult(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const item of result.content) {
		if (item.type === "text") parts.push(item.text);
	}
	return normalizeLineEndings(parts.join("\n")).trimEnd();
}

type ResultDetails = {
	diff?: unknown;
	truncation?: {
		firstLineExceedsLimit?: boolean;
		outputLines?: number;
	};
	matchLimitReached?: unknown;
	resultLimitReached?: unknown;
	entryLimitReached?: unknown;
	linesTruncated?: unknown;
};

function countTextLines(text: string): number {
	const normalized = normalizeLineEndings(text).trimEnd();
	if (!normalized) return 0;
	let count = 1;
	for (let index = 0; index < normalized.length; index++) {
		if (normalized.charCodeAt(index) === 10) count++;
	}
	return count;
}

function stripGeneratedFooter(name: string, text: string, details: ResultDetails | undefined): string {
	if (name === "read") {
		return text.replace(/\n\n\[(?:Showing lines |\d+ more lines in file\.)[^\n]*\]$/u, "");
	}
	const hasGeneratedFooter = details?.truncation?.outputLines !== undefined
		|| details?.matchLimitReached !== undefined
		|| details?.resultLimitReached !== undefined
		|| details?.entryLimitReached !== undefined
		|| details?.linesTruncated !== undefined;
	return hasGeneratedFooter ? text.replace(/\n\n\[[^\n]*\]$/u, "") : text;
}

export function formatResultLineSummary(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output?: string,
): string | undefined {
	const details = result.details as ResultDetails | undefined;
	const text = name === "edit" && typeof details?.diff === "string"
		? details.diff
		: output ?? (name === "write"
			? String(args.content ?? "")
			: result.content.some((item) => item.type === "text")
				? getTextResult(result)
				: undefined);
	if (text === undefined) return undefined;
	const truncationLines = details?.truncation?.outputLines;
	const lineCount = !details?.truncation?.firstLineExceedsLimit
		&& typeof truncationLines === "number"
		&& Number.isInteger(truncationLines)
		&& truncationLines >= 0
		? truncationLines
		: countTextLines(stripGeneratedFooter(name, text, details));
	return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

export function getFileOutput(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	isError: boolean,
): string {
	if (isError || name === "read" || name === "grep" || name === "find" || name === "ls") {
		return getTextResult(result);
	}
	return name === "write" ? String(args.content ?? "") : "";
}
