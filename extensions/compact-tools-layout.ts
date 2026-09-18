import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	Container,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { normalizeLineEndings } from "./compact-tools-core.ts";
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

export function wrapEditResult(component: Component, theme: Theme): Component {
	return new CachedComponent((width) => {
		const lines = component.render(Math.max(1, width - 3));
		const first = lines.findIndex((line) => visibleWidth(line.trim()) > 0);
		if (first < 0) return [];
		const contentLines = lines.slice(first);
		let commonIndent = Number.POSITIVE_INFINITY;
		for (const line of contentLines) {
			const plain = stripTerminalSequences(line);
			if (plain.trim().length === 0) continue;
			commonIndent = Math.min(commonIndent, plain.match(/^ */)?.[0].length ?? 0);
			if (commonIndent === 0) break;
		}
		if (!Number.isFinite(commonIndent)) commonIndent = 0;
		const prefix = theme.fg("border", " │ ");
		return contentLines.map((line) => {
			const content = sliceByColumn(line, commonIndent, Math.max(0, visibleWidth(line) - commonIndent), true);
			return `${prefix}${content}`;
		});
	}, () => component.invalidate?.());
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
