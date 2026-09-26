import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { claudeFailure, lookHint, lookKind, pathOf, type LookKind } from "./compact-tools-claude.ts";
import { formatDurationMs, type RowStatus } from "./compact-tools-core.ts";
import { hookMethod } from "./compact-tools-hook.ts";
import { getTextResult } from "./compact-tools-invocation.ts";
import { chromePainter, paintIndicator } from "./compact-tools-palette.ts";
import type { ToolRuntime } from "./compact-tools-runtime.ts";
import { findChat, isKind, isSilent } from "./compact-tools-silent.ts";
import { captureViewport } from "./compact-tools-viewport.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

const WIDGET_KEY = "compact-tools-groups";

/** Claude Code's words for each way of looking around, in the order it lists them. */
const PHRASES: ReadonlyArray<{ kind: LookKind; running: string; done: string; singular: string; plural: string }> = [
	{ kind: "search", running: "searching for", done: "searched for", singular: "pattern", plural: "patterns" },
	{ kind: "read", running: "reading", done: "read", singular: "file", plural: "files" },
	{ kind: "list", running: "listing", done: "listed", singular: "directory", plural: "directories" },
];

export const EXPAND_HINT = "(ctrl+o to expand)";

/** The fields of Pi's tool row a group summary reads. */
export interface ToolRowLike {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: AgentToolResult<unknown> & { isError?: boolean };
	isPartial: boolean;
	expanded: boolean;
	render(width: number): string[];
	handleMouse?(event: unknown): unknown;
	invalidate(): void;
}

/** Whether a call without its result can still get one; the row itself answers the same way. */
export type CanRun = (row: ToolRowLike) => boolean;

const ALWAYS_RUNS: CanRun = () => true;

/**
 * A call with no result yet runs, unless it can no longer get one: restored from
 * the session without it, or left without it when its run ended. Then it waits,
 * as its row shows.
 */
export function memberStatus(row: ToolRowLike, canRun: CanRun = ALWAYS_RUNS): RowStatus {
	if (!row.result || row.isPartial) return canRun(row) ? "running" : "pending";
	return row.result.isError ? "error" : "success";
}

function argsOf(row: ToolRowLike): ToolArgs {
	return typeof row.args === "object" && row.args !== null ? row.args as ToolArgs : {};
}

// Keyed by the row and checked against its arguments, which stream in: a command is
// parsed once rather than on every frame the whole transcript repaints.
const kinds = new WeakMap<object, { args: unknown; kind: LookKind | undefined }>();

function kindOf(row: ToolRowLike): LookKind | undefined {
	const cached = kinds.get(row);
	if (cached && cached.args === row.args) return cached.kind;
	const kind = lookKind(row.toolName, argsOf(row));
	kinds.set(row, { args: row.args, kind });
	return kind;
}

function lastRunning(rows: readonly ToolRowLike[], canRun: CanRun): ToolRowLike | undefined {
	for (let index = rows.length - 1; index >= 0; index--) {
		if (memberStatus(rows[index]!, canRun) === "running") return rows[index];
	}
	return undefined;
}

/**
 * How many patterns, files, and directories a group covers, counted as Claude Code
 * counts them: files by distinct path, and reads by command only when no file was read.
 */
export function countGroup(rows: readonly ToolRowLike[]): Record<LookKind, number> {
	const counts: Record<LookKind, number> = { search: 0, read: 0, list: 0 };
	const paths = new Set<string>();
	let readCommands = 0;
	for (const row of rows) {
		const kind = kindOf(row);
		if (kind === "read" && row.toolName === "read") paths.add(pathOf(argsOf(row)));
		else if (kind === "read") readCommands++;
		else if (kind) counts[kind]++;
	}
	counts.read = paths.size > 0 ? paths.size : readCommands;
	return counts;
}

/**
 * "Searched for 2 patterns, read 3 files". While any call in the group still runs,
 * every verb reads in progress. `bold` marks the counts, as Claude Code does.
 */
export function summarizeGroup(
	rows: readonly ToolRowLike[],
	bold: (text: string) => string = (text) => text,
	canRun: CanRun = ALWAYS_RUNS,
): string {
	const counts = countGroup(rows);
	const running = lastRunning(rows, canRun) !== undefined;
	const text = PHRASES.filter((phrase) => counts[phrase.kind] > 0)
		.map((phrase) => {
			const count = counts[phrase.kind];
			return `${running ? phrase.running : phrase.done} ${bold(String(count))} ${count === 1 ? phrase.singular : phrase.plural}`;
		})
		.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** While a call runs, the line under its group names what it looks at. */
export function groupHint(rows: readonly ToolRowLike[], canRun: CanRun = ALWAYS_RUNS): string | undefined {
	const running = lastRunning(rows, canRun);
	if (!running) return undefined;
	return lookHint(running.toolName, argsOf(running)) || undefined;
}

/** Claude Code keeps a failure in view beneath the folded group. */
export function groupFailures(rows: readonly ToolRowLike[]): string[] {
	return rows.filter((row) => memberStatus(row) === "error")
		.map((row) => claudeFailure(row.toolName, getTextResult(row.result!)).headline);
}

/**
 * A finished group's lines, and everything they were drawn from. Only a group with
 * no running row is kept, so every row in it has its final result.
 */
type HeaderCache = {
	paint: string;
	width: number;
	expanded: boolean;
	rows: readonly ToolRowLike[];
	args: unknown[];
	results: unknown[];
	lines: string[];
};

type GroupState = { expanded: boolean; lastHostExpanded: boolean; header?: HeaderCache };

/** The colors a group line is drawn in, resolved once per frame rather than once per group. */
type Paint = { theme: Theme; chrome: (text: string) => string; key: string };

/** Theme colors a group line uses; a theme that changes any of them draws the lines anew. */
const PAINT_COLORS = ["toolTitle", "error", "success", "muted", "dim", "text", "borderMuted"] as const;

function headerStill(cache: HeaderCache, rows: readonly ToolRowLike[], paint: string, width: number, expanded: boolean): boolean {
	if (cache.paint !== paint || cache.width !== width || cache.expanded !== expanded || cache.rows.length !== rows.length) return false;
	return rows.every((row, index) => row === cache.rows[index] && row.args === cache.args[index]
		&& row.result === cache.results[index]);
}

/** A run of tool rows drawn as one summary line, which a click or Ctrl+O opens into the rows themselves. */
export class ToolGroupComponent extends Container {
	constructor(
		readonly rows: readonly ToolRowLike[],
		/** Every child the group folded, in order: its tool rows and the thinking between them. */
		members: readonly unknown[],
		private readonly state: GroupState,
		private readonly draw: (rows: readonly ToolRowLike[], width: number, expanded: boolean) => string[],
		private readonly onToggle: () => void,
	) {
		super();
		// Ctrl+O expands every tool row in Pi; the group follows it both ways.
		const hostExpanded = rows[0]!.expanded;
		if (state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = hostExpanded;
		}
		const header: Component = {
			render: (width) => this.draw(this.rows, width, this.state.expanded),
			invalidate() {},
			handleMouse: (event: { type?: string; button?: string }) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				captureViewport();
				this.state.expanded = !this.state.expanded;
				this.onToggle();
				return { handled: true };
			},
		} as Component;
		this.addChild(header);
		if (state.expanded) for (const member of members) this.addChild(member as Component);
	}
}

function isGroupable(child: unknown): child is ToolRowLike {
	return isKind(child, ToolExecutionComponent) && kindOf(child as ToolRowLike) !== undefined;
}

type AssistantLike = { lastMessage?: { content?: Array<{ type: string; text?: string }> } };

/** A turn with no text for the reader: it only thought, then handed off to tools. */
function isThinkingOnly(child: unknown): boolean {
	if (!isKind(child, AssistantMessageComponent)) return false;
	const content = (child as AssistantLike).lastMessage?.content ?? [];
	return !content.some((block) => block.type === "text" && block.text?.trim());
}

/**
 * What may sit between two calls of one group: a turn that only thought, and the
 * status lines Pi writes into the chat itself, such as "Tool output: collapsed".
 */
function isFoldable(child: unknown): boolean {
	return isThinkingOnly(child) || isKind(child, Text) || isKind(child, Spacer);
}

/**
 * Replace each run of reads, searches, and listings with one group. What sits
 * between two of them folds into the group, as Claude Code keeps thinking out
 * of the way; anything else, text, a command, an edit, ends the run.
 */
export function groupChildren(
	children: readonly unknown[],
	makeGroup: (rows: ToolRowLike[], members: unknown[]) => Component,
): unknown[] {
	const grouped: unknown[] = [];
	let rows: ToolRowLike[] = [];
	let members: unknown[] = [];
	let pending: unknown[] = [];
	const flush = () => {
		if (rows.length > 0) grouped.push(makeGroup(rows, members));
		rows = [];
		members = [];
	};
	for (const child of children) {
		if (isGroupable(child)) {
			rows.push(child);
			members.push(...pending, child);
			pending = [];
			continue;
		}
		if (rows.length > 0 && isFoldable(child)) {
			pending.push(child);
			continue;
		}
		flush();
		grouped.push(...pending, child);
		pending = [];
	}
	flush();
	grouped.push(...pending);
	return grouped;
}

/** Claude style: runs of reads, searches, and listings fold into one line each. */
export class ToolGroupController {
	private context: ExtensionContext | undefined;
	private readonly states = new WeakMap<object, GroupState>();
	/** This frame's colors, set as the chat starts drawing. */
	private paint: Paint | undefined;
	/** Asks the runtime, which knows which run each call belongs to, as the call's own row does. */
	private readonly canRun: CanRun = (row) => this.runtime.canRun(row.toolCallId);

	constructor(private readonly runtime: ToolRuntime) {}

	bind(ctx: ExtensionContext): void {
		this.dispose();
		this.context = ctx;
		// An invisible widget is the extension API's way to reach Pi's TUI and its chat.
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			const chat = findChat(tui);
			if (chat) {
				hookMethod(chat, "render", "claude.groups", (self, args, original) => {
					if (!this.context || isSilent() || this.runtime.config.style !== "claude") return original.apply(self, args);
					const children = self.children as unknown[];
					this.paint = this.resolvePaint();
					self.children = groupChildren(children, (rows, members) => this.makeGroup(rows, members, tui));
					try {
						return original.apply(self, args);
					} finally {
						self.children = children;
						this.paint = undefined;
					}
				});
			}
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
	}

	dispose(): void {
		this.context?.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		this.context = undefined;
	}

	private makeGroup(rows: ToolRowLike[], members: unknown[], tui: { requestRender(): void }): Component {
		const key = rows[0]!;
		let state = this.states.get(key);
		if (!state) {
			state = { expanded: key.expanded, lastHostExpanded: key.expanded };
			this.states.set(key, state);
		}
		const groupState = state;
		return new ToolGroupComponent(rows, members, state,
			(group, width, expanded) => this.drawCached(group, width, expanded, groupState), () => tui.requestRender());
	}

	private resolvePaint(): Paint | undefined {
		const theme = this.context?.ui.theme;
		if (!theme) return undefined;
		const chrome = chromePainter(theme);
		const key = PAINT_COLORS.map((color) => theme.fg(color, "x")).join("") + theme.bold("x") + chrome("x");
		return { theme, chrome, key };
	}

	/**
	 * A finished group draws the same lines until one of its rows, the width, the
	 * expansion, or the theme changes, so those lines are kept. A running group's
	 * line pulses and counts time, so it is drawn every frame.
	 */
	private drawCached(rows: readonly ToolRowLike[], width: number, expanded: boolean, state: GroupState): string[] {
		const paint = this.paint ?? this.resolvePaint();
		if (!paint) return [];
		if (lastRunning(rows, this.canRun)) return this.draw(rows, width, expanded, paint);
		if (state.header && headerStill(state.header, rows, paint.key, width, expanded)) return state.header.lines;
		const lines = this.draw(rows, width, expanded, paint);
		state.header = {
			paint: paint.key,
			width,
			expanded,
			rows: [...rows],
			args: rows.map((row) => row.args),
			results: rows.map((row) => row.result),
			lines,
		};
		return lines;
	}

	/**
	 * A group's line reads like any other row: its status dot, then what it did in
	 * the title style. While it runs the dot pulses and the line below names what it
	 * looks at.
	 */
	private draw(rows: readonly ToolRowLike[], width: number, expanded: boolean, paint: Paint): string[] {
		const { theme, chrome } = paint;
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows, this.canRun);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));
		// A call that waits for a result it will never get leaves the group waiting too.
		const status: RowStatus = running ? "running" : statuses.includes("error") ? "error"
			: statuses.includes("pending") ? "pending" : "success";
		const summary = summarizeGroup(rows, undefined, this.canRun);
		let title = `${paintIndicator(theme, status, this.runtime.frame)} ${theme.fg("toolTitle", theme.bold(summary))}`;
		if (running) {
			// The folded row is not drawn, so the line that pulses for it keeps the clock going.
			this.runtime.keepAnimating(running.toolCallId);
			const started = this.runtime.timing(running.toolCallId)?.startedAt;
			const elapsed = started === undefined ? 0 : Date.now() - started;
			title += `${elapsed >= 2000 ? chrome(` · ${formatDurationMs(elapsed)}`) : ""}…`;
		}
		if (!expanded) title += chrome(` ${EXPAND_HINT}`);
		const lines = ["", fit(` ${title}`)];
		const hintText = groupHint(rows, this.canRun);
		if (hintText) lines.push(fit(chrome(` └ ${hintText}`)));
		if (!expanded) for (const failure of groupFailures(rows)) lines.push(fit(chrome(" └ ") + theme.fg("error", failure)));
		return lines;
	}
}
