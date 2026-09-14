import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

function pathFrom(args: ToolArgs): string {
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? normalizeLineEndings(value) : "";
}

export function formatReadCallDetails(path: string, args: ToolArgs): string {
	const options: string[] = [];
	if (typeof args.offset === "number") options.push(`offset: ${args.offset}`);
	if (typeof args.limit === "number") options.push(`limit: ${args.limit}`);
	return options.length === 0 ? path : `${path} (${options.join(", ")})`;
}

export function getCallDetails(name: string, args: ToolArgs): string {
	const path = pathFrom(args) || (name === "grep" || name === "find" || name === "ls" ? "." : "");
	if (name === "read") return formatReadCallDetails(path, args);
	if (name !== "grep" && name !== "find") return path;
	const pattern = typeof args.pattern === "string" ? normalizeLineEndings(args.pattern) : "…";
	return name === "grep" ? `/${pattern}/ in ${path}` : `${pattern} in ${path}`;
}

function omitArgument(name: string, key: string): boolean {
	if (key === "path" || key === "file_path") return true;
	if (name === "read" && (key === "offset" || key === "limit")) return true;
	if (name === "write" && key === "content") return true;
	return (name === "grep" || name === "find") && key === "pattern";
}

export function getArgumentDetails(name: string, args: ToolArgs): ToolArgs {
	if (name === "edit") return {};
	const details: ToolArgs = {};
	for (const [key, value] of Object.entries(args)) {
		if (value !== undefined && !omitArgument(name, key)) details[key] = value;
	}
	return details;
}

export function getTextResult(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const item of result.content) {
		if (item.type === "text") parts.push(item.text);
	}
	return normalizeLineEndings(parts.join("\n")).trimEnd();
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
