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

function formatInlineValue(value: unknown): string {
	if (typeof value === "string") {
		const compact = normalizeLineEndings(value).replace(/\s+/gu, " ").trim();
		return compact || '""';
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	return JSON.stringify(value) ?? String(value);
}

export function formatArgumentSummary(name: string, args: ToolArgs): string | undefined {
	if (!INLINE_ARGUMENT_TOOLS.has(name)) return undefined;
	const arguments_ = Object.entries(collectArgumentDetails(name, args));
	if (arguments_.length === 0) return undefined;
	return arguments_.map(([key, value]) => `${key} ${formatInlineValue(value)}`).join(" · ");
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

export function formatReadResultSummary(result: AgentToolResult<unknown>): string | undefined {
	if (!result.content.some((item) => item.type === "text")) return undefined;
	const truncation = (result.details as {
		truncation?: { firstLineExceedsLimit?: boolean; outputLines?: number };
	} | undefined)?.truncation;
	if (truncation?.firstLineExceedsLimit) return undefined;
	let lineCount = truncation?.outputLines;
	if (!Number.isInteger(lineCount) || lineCount === undefined || lineCount < 0) {
		const content = getTextResult(result).replace(
			/\n\n\[(?:Showing lines |\d+ more lines in file\.)[^\n]*\]$/u,
			"",
		);
		lineCount = content.length === 0 ? 0 : content.split("\n").length;
	}
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
