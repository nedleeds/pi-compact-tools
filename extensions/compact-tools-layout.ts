import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	Container,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { diffTintRgb, fillRgb } from "./compact-tools-color.ts";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import { resolveLanguage } from "./compact-tools-language.ts";
import { highlightMarkdown } from "./compact-tools-markdown.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

class CachedComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly renderLines: (width: number) => string[],
		private readonly invalidateSource?: () => void,
	) {}

	render(width: number): string[] {
		if (this.cachedWidth !== width || !this.cachedLines) {
			this.cachedWidth = width;
			this.cachedLines = this.renderLines(width);
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.invalidateSource?.();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** A Container that does not re-copy all child lines on every fullscreen scroll frame. */
export class CachedContainer extends Container {
	private cachedWidth?: number;
	private cachedLines?: string[];

	private clearRenderCache(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.clearRenderCache();
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		this.clearRenderCache();
	}

	override clear(): void {
		super.clear();
		this.clearRenderCache();
	}

	override render(width: number): string[] {
		if (this.cachedWidth !== width || !this.cachedLines) {
			this.cachedWidth = width;
			this.cachedLines = super.render(width);
		}
		return this.cachedLines;
	}

	override invalidate(): void {
		super.invalidate();
		this.clearRenderCache();
	}
}

export function prefixedText(text: string, firstPrefix: string, continuationPrefix = firstPrefix): Component {
	const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
	const normalized = text.replace(/\t/g, "   ");
	return new CachedComponent((width) => {
		const lines = wrapTextWithAnsi(normalized, Math.max(1, width - prefixWidth));
		return lines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`);
	});
}

export function hardWrapTextWithAnsi(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const wrapped: string[] = [];
	for (const logicalLine of text.replace(/\t/g, "   ").split("\n")) {
		const lineWidth = visibleWidth(logicalLine);
		if (lineWidth === 0) {
			wrapped.push("");
			continue;
		}
		let offset = 0;
		while (offset < lineWidth) {
			if (offset > 0) {
				const remainder = sliceByColumn(logicalLine, offset, lineWidth - offset, true);
				const whitespace = stripTerminalSequences(remainder).match(/^\s+/u)?.[0] ?? "";
				offset += visibleWidth(whitespace);
				if (offset >= lineWidth) break;
			}
			wrapped.push(sliceByColumn(logicalLine, offset, safeWidth, true));
			offset += safeWidth;
		}
	}
	return wrapped;
}

export function renderToolCall(title: string, details: string | undefined, theme: Theme): Component {
	const text = details ? `${title} ${details}` : title;
	const firstPrefix = " ";
	const continuationPrefix = theme.fg("border", " │ ");
	const prefixWidth = visibleWidth(continuationPrefix);
	return new CachedComponent((width) => {
		const lines = hardWrapTextWithAnsi(text, width - prefixWidth);
		return lines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`);
	});
}

export function styleMultiline(text: string, style: (line: string) => string): string {
	return normalizeLineEndings(text).split("\n").map(style).join("\n");
}

export function renderOutput(output: string, theme: Theme, isError: boolean): Component | undefined {
	const normalized = normalizeLineEndings(output).trimEnd();
	if (!normalized) return undefined;
	const color = isError ? "error" : "toolOutput";
	const styled = normalized.split("\n").map((line) => theme.fg(color, line)).join("\n");
	return prefixedText(styled, theme.fg("border", " │ "));
}

export type CodeDiffLineKind = "context" | "add" | "remove" | "separator";

export type CodeDiffLine = {
	kind: CodeDiffLineKind;
	lineNumber?: number;
	content: string;
	hunk: number;
};

export type CodeDiffOptions = {
	/** Context lines kept around each change; omit to keep every context line the diff carries. */
	contextLines?: number;
};

const DIFF_SEPARATOR = "\u22ee";

function parseUnifiedPatch(patch: string): CodeDiffLine[] {
	const result: CodeDiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;
	let hunk = -1;
	for (const line of normalizeLineEndings(patch).split("\n")) {
		const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
		if (header) {
			if (hunk >= 0) result.push({ kind: "separator", content: DIFF_SEPARATOR, hunk });
			hunk++;
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			continue;
		}
		if (hunk < 0 || line.startsWith("\\ No newline at end of file")) continue;
		const prefix = line[0];
		const content = line.slice(1).replace(/\t/gu, "   ");
		if (prefix === "+") {
			result.push({ kind: "add", lineNumber: newLine++, content, hunk });
		} else if (prefix === "-") {
			result.push({ kind: "remove", lineNumber: oldLine++, content, hunk });
		} else if (prefix === " ") {
			result.push({ kind: "context", lineNumber: newLine++, content, hunk });
			oldLine++;
		}
	}
	return result;
}

function parseDisplayDiff(diff: string): CodeDiffLine[] {
	const result: CodeDiffLine[] = [];
	let hunk = 0;
	for (const line of normalizeLineEndings(diff).split("\n")) {
		if (/^\s*\.\.\.\s*$/u.test(line)) {
			result.push({ kind: "separator", content: DIFF_SEPARATOR, hunk: hunk++ });
			continue;
		}
		const match = line.match(/^([ +\-])(\s*\d+)\s(.*)$/u);
		if (!match) continue;
		result.push({
			kind: match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context",
			lineNumber: Number(match[2]),
			content: match[3]!.replace(/\t/gu, "   "),
			hunk,
		});
	}
	return result;
}

/** Parse a standard patch, falling back to Pi's display-oriented numbered diff. */
export function parseCodeDiff(patch: string, displayDiff = ""): CodeDiffLine[] {
	const parsedPatch = patch ? parseUnifiedPatch(patch) : [];
	return parsedPatch.length > 0 ? parsedPatch : parseDisplayDiff(displayDiff);
}

/** Drop context that sits far from any change so a collapsed preview still reaches the edit. */
export function trimDiffContext(lines: CodeDiffLine[], contextLines: number): CodeDiffLine[] {
	const kept = lines.map((line) => line.kind !== "context");
	lines.forEach((line, index) => {
		if (line.kind !== "add" && line.kind !== "remove") return;
		for (let offset = 1; offset <= contextLines; offset++) {
			if (lines[index - offset]?.kind === "context") kept[index - offset] = true;
			if (lines[index + offset]?.kind === "context") kept[index + offset] = true;
		}
	});
	const result: CodeDiffLine[] = [];
	lines.forEach((line, index) => {
		if (kept[index]) {
			result.push(line);
			return;
		}
		if (result.length > 0 && result[result.length - 1]!.kind !== "separator") {
			result.push({ kind: "separator", content: DIFF_SEPARATOR, hunk: line.hunk });
		}
	});
	while (result.length > 0 && result[result.length - 1]!.kind === "separator") result.pop();
	return result;
}

/** Past these sizes syntax highlighting costs more than it helps; mirrors Codex's diff renderer. */
const HIGHLIGHT_MAX_CHARS = 512 * 1024;
const HIGHLIGHT_MAX_LINES = 10_000;
const HIGHLIGHT_MAX_LINE_CHARS = 4 * 1024;

function canHighlight(lines: readonly CodeDiffLine[]): boolean {
	if (lines.length > HIGHLIGHT_MAX_LINES) return false;
	let total = 0;
	for (const line of lines) {
		if (line.content.length > HIGHLIGHT_MAX_LINE_CHARS) return false;
		total += line.content.length + 1;
		if (total > HIGHLIGHT_MAX_CHARS) return false;
	}
	return true;
}

/** Highlight each hunk as one block so multi-line strings and comments keep their state. */
function highlightCodeLines(lines: CodeDiffLine[], language: string | undefined, theme: Theme): string[] {
	if (!language || !canHighlight(lines)) {
		return lines.map((line) => line.kind === "separator" ? line.content : theme.fg("toolOutput", line.content));
	}
	const rendered = new Array<string>(lines.length);
	let index = 0;
	while (index < lines.length) {
		if (lines[index]!.kind === "separator") {
			rendered[index] = lines[index]!.content;
			index++;
			continue;
		}
		let end = index;
		while (end < lines.length && lines[end]!.kind !== "separator") end++;
		const block = lines.slice(index, end);
		const contents = block.map((line) => line.content);
		const highlighted = language === "markdown"
			? highlightMarkdown(contents, theme)
			: highlightCode(contents.join("\n"), language);
		block.forEach((line, offset) => {
			rendered[index + offset] = highlighted[offset] ?? line.content;
		});
		index = end;
	}
	return rendered;
}

function hardSliceAnsi(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lineWidth = visibleWidth(text);
	if (lineWidth === 0) return [""];
	const slices: string[] = [];
	for (let offset = 0; offset < lineWidth; offset += safeWidth) {
		slices.push(sliceByColumn(text, offset, safeWidth, true));
	}
	return slices;
}

function codeGutter(
	kind: CodeDiffLineKind,
	lineNumber: number | undefined,
	numberWidth: number,
	signs: boolean,
	theme: Theme,
): string {
	const number = (lineNumber === undefined ? "" : String(lineNumber)).padStart(numberWidth);
	if (!signs) return theme.fg("toolDiffContext", `${number}  `);
	const sign = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
	const color = kind === "add" ? "toolDiffAdded" : kind === "remove" ? "toolDiffRemoved" : "toolDiffContext";
	return theme.fg(color, `${number} ${sign} `);
}

type CodeRowsOptions = {
	/** Show the `+`/`-` sign column and tint changed rows. */
	signs: boolean;
	/** Dim note rendered below the code, such as a read truncation notice. */
	footer?: string;
};

/** Render numbered, syntax-highlighted code rows shared by edit diffs and read/write file views. */
function renderCodeRows(lines: CodeDiffLine[], path: string, theme: Theme, options: CodeRowsOptions): Component {
	// A shebang only speaks for the file when the first row really is line 1, so a
	// read at an offset or a diff hunk never reads one out of a comment.
	const first = lines[0];
	const shebangLine = first?.lineNumber === 1 && first.kind !== "separator" ? first.content : undefined;
	const highlighted = highlightCodeLines(lines, resolveLanguage(path, shebangLine), theme);
	const numberWidth = Math.max(1, ...lines.map((line) => String(line.lineNumber ?? "").length));
	const prefix = theme.fg("border", " \u2502 ");
	const prefixWidth = visibleWidth(prefix);
	const gutterWidth = numberWidth + (options.signs ? 3 : 2);
	const addedTint = options.signs ? diffTintRgb(theme, "toolDiffAdded") : undefined;
	const removedTint = options.signs ? diffTintRgb(theme, "toolDiffRemoved") : undefined;
	return new CachedComponent((width) => {
		const bodyWidth = Math.max(1, width - prefixWidth);
		const codeWidth = Math.max(1, bodyWidth - gutterWidth);
		const output: string[] = [];
		lines.forEach((line, index) => {
			if (line.kind === "separator") {
				output.push(prefix + " ".repeat(numberWidth + 1) + theme.fg("toolDiffContext", line.content));
				return;
			}
			const tint = line.kind === "add" ? addedTint : line.kind === "remove" ? removedTint : undefined;
			for (const [chunkIndex, chunk] of hardSliceAnsi(highlighted[index] ?? line.content, codeWidth).entries()) {
				const gutter = codeGutter(
					line.kind,
					chunkIndex === 0 ? line.lineNumber : undefined,
					numberWidth,
					options.signs,
					theme,
				);
				const body = gutter + chunk;
				if (!tint) {
					output.push(prefix + body);
					continue;
				}
				const padded = body + " ".repeat(Math.max(0, bodyWidth - visibleWidth(body)));
				output.push(prefix + fillRgb(theme, tint, padded));
			}
		});
		if (options.footer) {
			for (const line of wrapTextWithAnsi(options.footer, bodyWidth)) output.push(prefix + theme.fg("dim", line));
		}
		return output;
	});
}

/** Render an edit as a syntax-highlighted diff with a line-number gutter and tinted change rows. */
export function renderCodeDiff(
	patch: string,
	displayDiff: string,
	path: string,
	theme: Theme,
	options: CodeDiffOptions = {},
): Component | undefined {
	const diff = parseCodeDiff(patch, displayDiff);
	const lines = options.contextLines === undefined ? diff : trimDiffContext(diff, options.contextLines);
	if (lines.length === 0) return undefined;
	return renderCodeRows(lines, path, theme, { signs: true });
}

export type CodeViewOptions = {
	/** File line number of the first code line, e.g. a read's `offset`. */
	startLine?: number;
	footer?: string;
};

/** Render file contents with line numbers and syntax highlighting, matching the edit diff layout. */
export function renderCodeView(code: string, path: string, theme: Theme, options: CodeViewOptions = {}): Component | undefined {
	const normalized = normalizeLineEndings(code).replace(/\n+$/u, "");
	if (!normalized) return undefined;
	const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
	const lines = normalized.split("\n").map((content, index): CodeDiffLine => ({
		kind: "context",
		lineNumber: startLine + index,
		content: content.replace(/\t/gu, "   "),
		hunk: 0,
	}));
	return renderCodeRows(lines, path, theme, { signs: false, footer: options.footer });
}

/** Limit a result preview by rendered rows while preserving the full source component for expansion. */
export function limitComponentLines(component: Component, maximumLines: number, theme: Theme): Component {
	return new CachedComponent((width) => {
		const lines = component.render(width);
		if (lines.length <= maximumLines) return lines;
		const omitted = lines.length - maximumLines;
		return [
			...lines.slice(0, maximumLines),
			theme.fg("border", " │ ") + theme.fg("borderAccent", `… ${omitted} more ${omitted === 1 ? "line" : "lines"}`),
		];
	}, () => component.invalidate?.());
}

export function renderArguments(args: ToolArgs, theme: Theme): Component {
	const json = JSON.stringify(args, null, 2) ?? "{}";
	const styled = styleMultiline(json, (line) => theme.fg("toolOutput", line));
	return prefixedText(styled, theme.fg("border", " │ "));
}
