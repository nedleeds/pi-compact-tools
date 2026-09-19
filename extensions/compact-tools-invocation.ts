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

function shellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			current += character;
			escaped = true;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			current += character;
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (character === "\n" || character === ";" || pair === "&&" || pair === "||") {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if (pair === "&&" || pair === "||") index++;
			continue;
		}
		current += character;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function unquote(value: string): string {
	return value.replace(/^["']|["']$/gu, "");
}

/** A calm collapsed label that describes intent without exposing command arguments. */
export function summarizeShellCommand(name: string, command: string): string {
	const allSegments = shellSegments(normalizeLineEndings(command));
	const segments = allSegments.filter((segment) => !/^\s*(?:cd|pushd|popd)\b/iu.test(segment));
	const primary = segments[0] ?? allSegments[0] ?? "";
	if (!primary) return name === "powershell" ? "Prepare PowerShell command" : "Prepare shell command";

	const words = primary.trim().split(/\s+/u).map(unquote);
	while (words.length > 0) {
		if (/^[A-Za-z_][A-Za-z\d_]*=.*/u.test(words[0] ?? "")
			|| ["command", "env", "sudo", "time"].includes((words[0] ?? "").toLowerCase())) {
			words.shift();
			continue;
		}
		break;
	}
	const executable = (words[0] ?? "").replace(/^.*[\\/]/u, "").replace(/\.(?:cmd|exe|ps1)$/iu, "").toLowerCase();
	const action = (words[1] ?? "").toLowerCase();
	const subject = words[2] ?? "";

	let summary: string;
	if (["npm", "pnpm", "yarn", "bun"].includes(executable) && action === "run" && subject) {
		summary = `Run ${subject} task`;
	} else if (["npm", "pnpm", "yarn", "bun"].includes(executable) && ["test", "check"].includes(action)) {
		summary = action === "test" ? "Run tests" : "Run project checks";
	} else if (["npm", "pnpm", "yarn", "bun"].includes(executable) && ["install", "i", "ci"].includes(action)) {
		summary = "Install dependencies";
	} else if (executable === "git" && action === "status") {
		summary = "Check repository status";
	} else if (executable === "git" && action === "diff") {
		summary = "Review repository changes";
	} else if (executable === "git" && action === "log") {
		summary = "Review commit history";
	} else if (executable === "git" && ["fetch", "pull", "push", "clone"].includes(action)) {
		summary = `${action[0]!.toUpperCase()}${action.slice(1)} repository`;
	} else if (["rg", "grep", "select-string"].includes(executable)) {
		summary = "Search text";
	} else if (["find", "fd", "get-childitem", "ls", "dir"].includes(executable)) {
		summary = executable === "ls" || executable === "dir" || executable === "get-childitem" ? "List files" : "Find files";
	} else if (["cat", "type", "get-content"].includes(executable)) {
		summary = "Read file content";
	} else if (["tsc", "mypy", "pyright"].includes(executable)) {
		summary = "Check types";
	} else if (["jest", "vitest", "pytest", "invoke-pester"].includes(executable)) {
		summary = "Run tests";
	} else if (executable) {
		const display = executable.replace(/[-_]+/gu, " ");
		summary = `Run ${display}`;
	} else {
		summary = name === "powershell" ? "Run PowerShell command" : "Run shell command";
	}

	const remainingSteps = Math.max(0, segments.length - 1);
	return remainingSteps > 0 ? `${summary} + ${remainingSteps} more ${remainingSteps === 1 ? "step" : "steps"}` : summary;
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

/** Keep only the lines that the edit actually removed or added; discard context and ellipses. */
export function getEditChanges(result: AgentToolResult<unknown>): string {
	const diff = (result.details as ResultDetails | undefined)?.diff;
	if (typeof diff !== "string") return "";
	return normalizeLineEndings(diff)
		.split("\n")
		.filter((line) => line.startsWith("-") || line.startsWith("+"))
		.join("\n")
		.trimEnd();
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
	const text = name === "edit"
		? getEditChanges(result)
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
