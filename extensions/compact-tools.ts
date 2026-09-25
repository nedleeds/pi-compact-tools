import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { classifyCallStatus, formatDurationMs, normalizeLineEndings, type RowStatus } from "./compact-tools-core.ts";
import { loadConfig } from "./compact-tools-config.ts";
import { installToolRowPatch, setRowResolver, type RowRenderers, type ToolRow } from "./compact-tools-custom.ts";
import {
	formatResultLineSummary,
	countEditChanges,
	getArgumentDetails,
	getCallDetails,
	getEditDiff,
	getEditPatch,
	getFileOutput,
	getTextResult,
	isReadTextResult,
	splitReadFooter,
	summarizeCustomArguments,
	summarizeFailure,
	summarizeShellCommand,
} from "./compact-tools-invocation.ts";
import {
	CachedContainer,
	claudeRows,
	limitComponentLines,
	prefixedLines,
	prefixedText,
	railComponent,
	renderArguments,
	renderCodeDiff,
	renderCodeView,
	renderOutput,
	renderToolCall,
	styleMultiline,
} from "./compact-tools-layout.ts";
import { CLAUDE_DIFF_CONTEXT_LINES, CLAUDE_OUTPUT_ROWS, CLAUDE_WRITE_ROWS, claudeFailure, claudeOutcome, claudeTitle } from "./compact-tools-claude.ts";
import { ToolGroupController } from "./compact-tools-grouping.ts";
import { chromePainter, paintIndicator } from "./compact-tools-palette.ts";
import { ProgressController } from "./compact-tools-progress.ts";
import { showReleaseNotice } from "./compact-tools-release.ts";
import { ToolRuntime } from "./compact-tools-runtime.ts";
import { SilentModeController } from "./compact-tools-silent.ts";
import { ThinkingCycleController } from "./compact-tools-thinking.ts";
import { ViewportKeeper } from "./compact-tools-viewport.ts";
import {
	SUPPORTED_TOOL_SET,
	type BuiltInDefinition,
	type CompactToolName,
	type RenderContext,
	type RowState,
	type ToolArgs,
} from "./compact-tools-types.ts";

/** Context lines kept around each change while an edit result is collapsed. */
const PREVIEW_DIFF_CONTEXT_LINES = 1;
/** Claude Code sets what a call returned under the "⎿" rather than beside a rail. */
const CLAUDE_INDENT = "   ";

const runtime = new ToolRuntime();
const registeredTools = new Set<CompactToolName>();
let registeredConfiguration: string | undefined;

/** How a tool's row is drawn: a file tool's result is code, a shell's is output, a custom tool's is its author's. */
type RowKind = "file" | "shell" | "custom";
type AuthorResultRenderer = (expanded: boolean) => Component | undefined;

function rowKind(name: string): RowKind {
	return name === "bash" || name === "powershell" ? "shell" : SUPPORTED_TOOL_SET.has(name) ? "file" : "custom";
}

function isClaude(): boolean {
	return runtime.config.style === "claude";
}

function pathArgument(args: ToolArgs): string {
	return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
}

function callStatus(ctx: RenderContext, state: RowState): RowStatus {
	// write/edit arguments can stream for much longer than their eventual filesystem
	// operation. Treat that active tool-call phase as running so every built-in row
	// animates consistently instead of waiting for execute() to begin.
	const active = ctx.executionStarted || !ctx.argsComplete;
	return classifyCallStatus(ctx.isError, active, state.endedAt !== undefined);
}

function renderIndicator(theme: Theme, ctx: RenderContext, state: RowState): string {
	const status = callStatus(ctx, state);
	return paintIndicator(theme, status, runtime.syncIndicator(ctx.toolCallId, status === "running", () => ctx.invalidate()));
}

function formatDuration(state: RowState): string | undefined {
	if (state.startedAt === undefined) return undefined;
	return formatDurationMs((state.endedAt ?? Date.now()) - state.startedAt);
}

function canReuseResult<TArgs>(
	state: RowState,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	ctx: RenderContext<TArgs>,
): ctx is RenderContext<TArgs> & { lastComponent: Component } {
	return ctx.lastComponent !== undefined
		&& state.lastResultContent === result.content
		&& state.lastResultDetails === result.details
		&& state.lastResultPartial === options.isPartial
		&& state.lastResultExpanded === state.expanded
		&& state.lastResultPreview === state.preview
		&& state.lastResultError === ctx.isError
		&& state.lastResultConfigRevision === state.configRevision;
}

function rememberResult(state: RowState, result: AgentToolResult<unknown>, options: ToolRenderResultOptions, isError: boolean): void {
	state.lastResultContent = result.content;
	state.lastResultDetails = result.details;
	state.lastResultPartial = options.isPartial;
	state.lastResultExpanded = state.expanded;
	state.lastResultPreview = state.preview;
	state.lastResultError = isError;
	state.lastResultConfigRevision = state.configRevision;
}

function renderControls(
	theme: Theme,
	state: RowState,
	running: boolean,
	isError: boolean,
	failureReason?: string,
	changes?: { added: number; removed: number },
): Component {
	const duration = running ? undefined : formatDuration(state);
	const status = running
		? (duration ?? "Running")
		: `${isError ? "Failed" : "Done"}${duration ? ` in ${duration}` : ""}`;
	// A failed row already reads as an error through its output color and Pi's row
	// background, so the status word stays chrome rather than repeating that signal.
	const chrome = chromePainter(theme);
	let details = chrome(status);
	if (failureReason && isError && !running) details += chrome(" · ") + theme.fg("error", failureReason);
	// An edit reports what it changed the way a diff does: lines added and removed.
	else if (changes && !running && !isError) {
		details += chrome(" (") + theme.fg("toolDiffAdded", `+${changes.added}`) + chrome(" ")
			+ theme.fg("toolDiffRemoved", `-${changes.removed}`) + chrome(")");
	}
	// A failed call produced no result worth counting; "(0 lines)" would only mislead.
	else if (state.resultLineSummary && !running && !isError) details += chrome(` (${state.resultLineSummary})`);
	return prefixedText(details, chrome(" └ "), "   ");
}

/** Arguments a one-line summary cannot show: objects, or lists of them. */
function hasNestedArguments(args: ToolArgs): boolean {
	return Object.values(args).some((value) => typeof value === "object" && value !== null
		&& (!Array.isArray(value) || value.some((item) => typeof item === "object" && item !== null)));
}

/** The call line: a status dot, the tool, and what it was asked, then any arguments the line leaves out. */
function renderRowCall(name: string, args: ToolArgs, theme: Theme, ctx: RenderContext): Component {
	const state = runtime.syncRow(ctx, ctx.state.endedAt === undefined);
	runtime.syncExpansion(state, ctx.expanded, name);
	const kind = rowKind(name);
	const container = new CachedContainer();
	if (isClaude()) {
		// Claude Code's call line: `⦁ Bash(npm test)`, `⦁ Update(src/app.ts)`.
		const { label, argument } = claudeTitle(name, args, state.expanded === true);
		const title = `${renderIndicator(theme, ctx, state)} ${theme.fg("toolTitle", theme.bold(label))}`
			+ (argument ? styleMultiline(`(${argument})`, (line) => theme.fg("toolOutput", line)) : "");
		// The title wraps rather than being cut to the row; only a very long command is shortened.
		container.addChild(renderToolCall(title, undefined, theme));
		// The title already lists plain arguments; only nested ones need the full view.
		if (kind === "custom" && state.expanded && hasNestedArguments(args)) container.addChild(renderArguments(args, theme));
		return container;
	}
	const title = `${renderIndicator(theme, ctx, state)} ${theme.fg("toolTitle", theme.bold(name))}`;
	let details: string | undefined;
	if (kind === "shell") {
		const command = normalizeLineEndings(typeof args.command === "string" ? args.command : "");
		details = state.expanded
			? styleMultiline(command || "…", (line) => theme.fg("toolOutput", line))
			: theme.fg("toolOutput", summarizeShellCommand(name, command));
	} else {
		const summary = kind === "file" ? getCallDetails(name, args) : summarizeCustomArguments(args);
		details = summary ? styleMultiline(summary, (line) => theme.fg("toolOutput", line)) : undefined;
	}
	container.addChild(renderToolCall(title, details, theme));
	const extra = kind === "file" ? getArgumentDetails(name, args) : kind === "custom" && state.expanded ? args : {};
	if (Object.keys(extra).length > 0) container.addChild(renderArguments(extra, theme));
	return container;
}

/** A result body as code where it is code: numbered file text, or an edit's diff. */
function renderFileBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	isError: boolean,
): Component | undefined {
	if (isError) return renderOutput(output, theme, isError);
	const path = pathArgument(args);
	if (name === "edit" && getEditDiff(result)) {
		return renderCodeDiff(getEditPatch(result), getEditDiff(result), path, theme,
			expanded ? {} : { contextLines: PREVIEW_DIFF_CONTEXT_LINES }) ?? renderOutput(output, theme, isError);
	}
	if (name === "read" && isReadTextResult(result)) {
		const { body, footer } = splitReadFooter(output);
		const startLine = typeof args.offset === "number" ? args.offset : 1;
		return renderCodeView(body, path, theme, { startLine, footer }) ?? renderOutput(output, theme, isError);
	}
	if (name === "write") return renderCodeView(output, path, theme) ?? renderOutput(output, theme, isError);
	return renderOutput(output, theme, isError);
}

function renderRowBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	isError: boolean,
	author: AuthorResultRenderer | undefined,
): Component | undefined {
	if (rowKind(name) !== "custom") return renderFileBody(name, args, result, output, expanded, theme, isError);
	if (author) {
		try {
			const component = author(expanded);
			if (component) return railComponent(component, theme);
		} catch {
			// A failing third-party renderer degrades to the plain text result.
		}
	}
	return renderOutput(output, theme, isError);
}

function claudeMoreLines(theme: Theme, hidden: number): string {
	return chromePainter(theme)(`… +${hidden} ${hidden === 1 ? "line" : "lines"} (ctrl+o to expand)`);
}

/** Output previewed in rows the way Claude Code previews it, all of it once opened. */
function claudeOutput(output: string, expanded: boolean, theme: Theme, isError: boolean, empty: string, firstPrefix: string): Component {
	const normalized = normalizeLineEndings(output).trimEnd();
	// Pi's bash reports an empty run as "(no output)"; Claude Code dims its own words for it.
	const lines = !normalized || normalized === "(no output)"
		? [chromePainter(theme)(empty)]
		: normalized.split("\n").map((line) => theme.fg(isError ? "error" : "toolOutput", line));
	return claudeRows(lines, firstPrefix, CLAUDE_INDENT, expanded ? undefined : CLAUDE_OUTPUT_ROWS,
		(hidden) => claudeMoreLines(theme, hidden));
}

/**
 * What Claude Code draws beneath a finished call: an edit's every hunk, a write's
 * first rows, the author's view of a custom tool once opened, and otherwise
 * nothing until the row is opened.
 */
function claudeBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	author: AuthorResultRenderer | undefined,
): Component | undefined {
	const path = pathArgument(args);
	if (name === "edit") {
		return renderCodeDiff(getEditPatch(result), getEditDiff(result), path, theme,
			{ contextLines: CLAUDE_DIFF_CONTEXT_LINES, rail: CLAUDE_INDENT });
	}
	if (name === "write") {
		const component = renderCodeView(output, path, theme, { rail: CLAUDE_INDENT });
		return component && !expanded
			? limitComponentLines(component, CLAUDE_WRITE_ROWS, theme, (hidden) => CLAUDE_INDENT + claudeMoreLines(theme, hidden))
			: component;
	}
	// A command's output is already the result line itself.
	const kind = rowKind(name);
	if (!expanded || kind === "shell") return undefined;
	if (kind === "custom") return author ? renderRowBody(name, args, result, output, true, theme, false, author) : undefined;
	return renderFileBody(name, args, result, output, true, theme, false);
}

/**
 * Claude Code's result block: a "└" line saying what happened, or the output
 * itself for commands and custom tools, then any diff or code beneath it.
 */
function renderClaudeResult(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	expanded: boolean,
	output: string,
	author: AuthorResultRenderer | undefined,
): Component {
	const chrome = chromePainter(theme);
	const container = new CachedContainer();
	// One line under the call, wrapped rather than cut to the row.
	const line = (text: string) => prefixedLines(text, chrome(" └ "), CLAUDE_INDENT, false);
	if (options.isPartial) {
		container.addChild(line(chrome("Running…")));
		return container;
	}
	if (isError) {
		const failure = claudeFailure(name, output);
		// A command's output says why beneath its exit code; another tool's message is
		// shortened to one line, and a click shows it whole in its place.
		if (failure.detail) {
			container.addChild(line(theme.fg("error", failure.headline)));
			container.addChild(claudeOutput(failure.detail, expanded, theme, true, "", CLAUDE_INDENT));
		} else if (expanded && output.trim()) {
			container.addChild(claudeOutput(`Error: ${output.trim()}`, true, theme, true, "", chrome(" └ ")));
		} else {
			container.addChild(line(theme.fg("error", failure.headline)));
		}
		return container;
	}
	const body = claudeBody(name, args, result, output, expanded, theme, author);
	// The author's view already shows a custom tool's output, so the line above it only counts it.
	const outcome = body && rowKind(name) === "custom"
		? formatResultLineSummary(name, args, result, output) ?? "Done"
		: claudeOutcome(name, args, result, output, (value) => theme.bold(value));
	if (outcome !== undefined) container.addChild(line(theme.fg("toolOutput", outcome)));
	else container.addChild(claudeOutput(output, expanded, theme, false, rowKind(name) === "shell" ? "(No output)" : "(No content)", chrome(" └ ")));
	if (body) container.addChild(body);
	return container;
}

/**
 * The result under a call: a preview or the whole of it when shown, and a status
 * line with how long it took and how much it returned. An unchanged result reuses
 * the component it drew last, so a large output is laid out once.
 */
function renderRowResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
	author?: AuthorResultRenderer,
): Component {
	const state = runtime.syncRow(ctx, options.isPartial, !options.isPartial);
	runtime.syncExpansion(state, ctx.expanded, name);
	if (canReuseResult(state, result, options, ctx)) return ctx.lastComponent;
	const kind = rowKind(name);
	const output = kind === "file" ? getFileOutput(name, ctx.args, result, ctx.isError) : getTextResult(result);
	const hasEditDiff = name === "edit" && getEditDiff(result).length > 0;
	runtime.setResultAvailable(state, name, hasEditDiff || output.length > 0 || author !== undefined);
	let component: Component;
	if (isClaude()) {
		component = renderClaudeResult(name, ctx.args, result, options, theme, ctx.isError, state.expanded === true, output, author);
	} else {
		if (!options.isPartial && !state.resultLineSummaryComputed) {
			// A custom tool with no text has nothing to count.
			state.resultLineSummary = kind === "custom" && !output ? undefined : formatResultLineSummary(name, ctx.args, result, output);
			state.resultLineSummaryComputed = true;
		}
		const container = new CachedContainer();
		if (state.expanded || state.preview) {
			const body = renderRowBody(name, ctx.args, result, output, state.expanded === true, theme, ctx.isError, author);
			if (body) container.addChild(state.expanded ? body : limitComponentLines(body, runtime.config.previewLines, theme));
		}
		// A failed row whose output is hidden gets its reason on the status line. When
		// the output shows, it already says why, and repeating it only doubles the error.
		const failureReason = ctx.isError && !state.expanded && !state.preview ? summarizeFailure(name, output) : undefined;
		container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, failureReason,
			name === "edit" ? countEditChanges(result) : undefined));
		component = container;
	}
	rememberResult(state, result, options, ctx.isError);
	return component;
}

/**
 * Compact renderers for one row of a tool this extension did not register. The
 * author's result renderer still draws the expanded body; the row chrome, status,
 * and collapse behavior match the built-ins.
 */
function createCustomRenderers(name: string, author: ToolDefinition<any, any, any> | undefined): RowRenderers {
	// Pi hands both renderers the row's own state object, which belongs to the tool's
	// author. Compact bookkeeping is kept here so neither side overwrites the other.
	const state: RowState = {};
	let authorResult: Component | undefined;
	const own = (ctx: RenderContext<any>): RenderContext => ({ ...ctx, args: ctx.args ?? {}, state });
	return {
		renderCall: (args, theme, ctx) => renderRowCall(name, (args ?? {}) as ToolArgs, theme, own(ctx)),
		renderResult: (result, options, theme, ctx) => {
			const authorRenderer = author?.renderResult;
			const renderAuthorResult = authorRenderer
				? (expanded: boolean) => {
					authorResult = authorRenderer(result, { ...options, expanded }, theme, { ...ctx, lastComponent: authorResult });
					return authorResult;
				}
				: undefined;
			return renderRowResult(name, result, options, theme, own(ctx), renderAuthorResult);
		},
	};
}

function resolveCustomRow(row: ToolRow): RowRenderers | undefined {
	const customTools = runtime.config.custom_tools;
	// Built-ins are governed by `tools`: ones left out keep Pi's own renderer.
	if (runtime.config.style === "off" || !customTools.enabled || SUPPORTED_TOOL_SET.has(row.toolName)) return undefined;
	if (customTools.exclude.includes(row.toolName)) return undefined;
	return createCustomRenderers(row.toolName, row.toolDefinition);
}

const toolFactories: Record<CompactToolName, (cwd: string) => BuiltInDefinition> = {
	read: createReadToolDefinition,
	write: createWriteToolDefinition,
	edit: createEditToolDefinition,
	bash: createBashToolDefinition,
	powershell: createPowerShellToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

function registerCompactTool(pi: ExtensionAPI, definition: BuiltInDefinition): void {
	pi.registerTool({
		...definition,
		execute: runtime.createTimedExecute(definition),
		renderShell: "self",
		renderCall: (args: ToolArgs, theme: Theme, ctx: RenderContext) => renderRowCall(definition.name, args, theme, ctx),
		renderResult: (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, ctx: RenderContext) =>
			renderRowResult(definition.name, result, options, theme, ctx),
	} as ToolDefinition<any, any, RowState>);
}

/** Off leaves every tool with Pi's own renderer. */
function compactedTools(): CompactToolName[] {
	return runtime.config.style === "off" ? [] : runtime.config.tools;
}

function registerTools(pi: ExtensionAPI, cwd: string): void {
	const enabledTools = new Set(compactedTools());
	for (const name of registeredTools) {
		// Pi exposes no unregister API, so restoring a disabled tool means re-registering
		// the built-in definition to release this extension's renderers.
		if (!enabledTools.has(name)) pi.registerTool(toolFactories[name](cwd));
	}
	registeredTools.clear();
	for (const name of compactedTools()) {
		registerCompactTool(pi, toolFactories[name](cwd));
		registeredTools.add(name);
	}
}

function configure(pi: ExtensionAPI, cwd?: string, projectTrusted = false): void {
	const resolvedCwd = cwd ?? process.cwd();
	const config = loadConfig(resolvedCwd, projectTrusted);
	const signature = JSON.stringify([resolvedCwd, config]);
	if (signature === registeredConfiguration) return;
	runtime.configure(config);
	registerTools(pi, resolvedCwd);
	registeredConfiguration = signature;
}

export default function compactTools(pi: ExtensionAPI): void {
	// Pi caches this factory and re-invokes it with a fresh `pi` for every session
	// replacement (/resume, /new, /fork) as well as /reload, each time starting from
	// an empty tool registry. The module itself survives those invocations, so the
	// memo below has to be dropped here or configure() mistakes the previous
	// instance's registration for this one and never installs the renderers.
	registeredConfiguration = undefined;
	registeredTools.clear();

	const thinkingCycle = new ThinkingCycleController(pi);
	const progress = new ProgressController(pi);
	const viewport = new ViewportKeeper();
	const silent = new SilentModeController(pi, showReleaseNotice);
	const groups = new ToolGroupController(runtime);
	const customRowsAvailable = installToolRowPatch();
	setRowResolver(resolveCustomRow);
	let customRowsWarned = false;
	// Register once while the extension runtime is being built. In particular, this
	// makes the overrides available before Pi restores the active tool set on /reload.
	configure(pi, process.cwd());
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") runtime.clearTimings();
		configure(pi, ctx.cwd, ctx.isProjectTrusted());
		if (ctx.mode === "tui" && runtime.config.style !== "off") {
			// First, so its input listener sees relayout keys before the thinking controller consumes them.
			viewport.bind(ctx);
			progress.bind(ctx);
			thinkingCycle.bind(ctx);
			silent.bind(ctx, runtime.config.mode, event.reason === "reload");
			groups.bind(ctx);
			if (!silent.isEnabled()) showReleaseNotice(ctx);
			if (runtime.config.custom_tools.enabled && !customRowsAvailable && !customRowsWarned) {
				customRowsWarned = true;
				ctx.ui.notify("Compact rendering for custom tools is unavailable in this version of Pi", "warning");
			}
		} else {
			viewport.dispose();
			progress.dispose();
			thinkingCycle.dispose();
			silent.dispose();
			groups.dispose();
		}
	});
	pi.on("tool_execution_start", (event) => runtime.noteExecutionStart(event.toolCallId));
	pi.on("tool_execution_end", (event) => runtime.noteExecutionEnd(event.toolCallId));
	pi.on("session_shutdown", (event) => {
		thinkingCycle.dispose();
		progress.dispose();
		silent.dispose();
		groups.dispose();
		viewport.dispose();
		runtime.reset(event.reason !== "reload");
	});
}
