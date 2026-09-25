import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionContext,
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

export function memberStatus(row: ToolRowLike): RowStatus {
	if (!row.result || row.isPartial) return "running";
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

function lastRunning(rows: readonly ToolRowLike[]): ToolRowLike | undefined {
	for (let index = rows.length - 1; index >= 0; index--) {
		if (memberStatus(rows[index]!) === "running") return rows[index];
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
export function summarizeGroup(rows: readonly ToolRowLike[], bold: (text: string) => string = (text) => text): string {
	const counts = countGroup(rows);
	const running = lastRunning(rows) !== undefined;
	const text = PHRASES.filter((phrase) => counts[phrase.kind] > 0)
		.map((phrase) => {
			const count = counts[phrase.kind];
			return `${running ? phrase.running : phrase.done} ${bold(String(count))} ${count === 1 ? phrase.singular : phrase.plural}`;
		})
		.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** While a call runs, the line under its group names what it looks at. */
export function groupHint(rows: readonly ToolRowLike[]): string | undefined {
	const running = lastRunning(rows);
	if (!running) return undefined;
	return lookHint(running.toolName, argsOf(running)) || undefined;
}

/** Claude Code keeps a failure in view beneath the folded group. */
export function groupFailures(rows: readonly ToolRowLike[]): string[] {
	return rows.filter((row) => memberStatus(row) === "error")
		.map((row) => claudeFailure(row.toolName, getTextResult(row.result!)).headline);
}

type GroupState = { expanded: boolean; lastHostExpanded: boolean };

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
					self.children = groupChildren(children, (rows, members) => this.makeGroup(rows, members, tui));
					try {
						return original.apply(self, args);
					} finally {
						self.children = children;
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
		return new ToolGroupComponent(rows, members, state, (group, width, expanded) => this.draw(group, width, expanded),
			() => tui.requestRender());
	}

	/**
	 * A group's line reads like any other row: its status dot, then what it did in
	 * the title style. While it runs the dot pulses and the line below names what it
	 * looks at.
	 */
	private draw(rows: readonly ToolRowLike[], width: number, expanded: boolean): string[] {
		const theme = this.context?.ui.theme;
		if (!theme) return [];
		const chrome = chromePainter(theme);
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows);
		const failed = rows.some((row) => memberStatus(row) === "error");
		const status: RowStatus = running ? "running" : failed ? "error" : "success";
		let title = `${paintIndicator(theme, status, this.runtime.frame)} ${theme.fg("toolTitle", theme.bold(summarizeGroup(rows)))}`;
		if (running) {
			const started = this.runtime.timing(running.toolCallId)?.startedAt;
			const elapsed = started === undefined ? 0 : Date.now() - started;
			title += `${elapsed >= 2000 ? chrome(` · ${formatDurationMs(elapsed)}`) : ""}…`;
		}
		if (!expanded) title += chrome(` ${EXPAND_HINT}`);
		const lines = ["", fit(` ${title}`)];
		const hintText = groupHint(rows);
		if (hintText) lines.push(fit(chrome(` └ ${hintText}`)));
		if (!expanded) for (const failure of groupFailures(rows)) lines.push(fit(chrome(" └ ") + theme.fg("error", failure)));
		return lines;
	}
}
