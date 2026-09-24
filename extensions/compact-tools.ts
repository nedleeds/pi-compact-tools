import type {
	AgentToolResult,
	BashToolDetails,
	BashToolInput,
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
import type { Component, Container } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	indicatorGlyph,
	indicatorStrength,
	indicatorTone,
	normalizeLineEndings,
	type RowStatus,
} from "./compact-tools-core.ts";
import { colorizeRgb, interpolateRgb } from "./compact-tools-color.ts";
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
	limitComponentLines,
	prefixedText,
	railComponent,
	renderArguments,
	renderCodeDiff,
	renderCodeView,
	renderOutput,
	renderToolCall,
	styleMultiline,
} from "./compact-tools-layout.ts";
import { chromePainter, indicatorPulse } from "./compact-tools-palette.ts";
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
	type ShellToolName,
	type ToolArgs,
} from "./compact-tools-types.ts";

/** Context lines kept around each change while an edit result is collapsed. */
const PREVIEW_DIFF_CONTEXT_LINES = 1;

const runtime = new ToolRuntime();
const registeredTools = new Set<CompactToolName>();
let registeredConfiguration: string | undefined;

function callStatus(ctx: RenderContext, state: RowState): RowStatus {
	// write/edit arguments can stream for much longer than their eventual filesystem
	// operation. Treat that active tool-call phase as running so every built-in row
	// animates consistently instead of waiting for execute() to begin.
	const active = ctx.executionStarted || !ctx.argsComplete;
	return classifyCallStatus(ctx.isError, active, state.endedAt !== undefined);
}

function renderIndicator(theme: Theme, ctx: RenderContext, status: RowStatus): string {
	const frame = runtime.syncIndicator(ctx.toolCallId, status === "running", () => ctx.invalidate());
	const glyph = indicatorGlyph(status, frame);
	if (status === "running") {
		const pulse = indicatorPulse(theme);
		if (pulse) {
			return colorizeRgb(theme, interpolateRgb(pulse.from, pulse.to, indicatorStrength(status, frame)), glyph);
		}
	}
	return theme.fg(indicatorTone(status, frame), glyph);
}

function formatDuration(state: RowState): string | undefined {
	if (state.startedAt === undefined) return undefined;
	return formatDurationMs((state.endedAt ?? Date.now()) - state.startedAt);
}

function canReuseResult<TDetails, TArgs>(
	state: RowState,
	result: AgentToolResult<TDetails>,
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

function rememberResult<TDetails, TArgs>(
	state: RowState,
	result: AgentToolResult<TDetails>,
	options: ToolRenderResultOptions,
	ctx: RenderContext<TArgs>,
): void {
	state.lastResultContent = result.content;
	state.lastResultDetails = result.details;
	state.lastResultPartial = options.isPartial;
	state.lastResultExpanded = state.expanded;
	state.lastResultPreview = state.preview;
	state.lastResultError = ctx.isError;
	state.lastResultConfigRevision = state.configRevision;
}

function renderControls(
	theme: Theme,
	state: RowState,
	running: boolean,
	isError: boolean,
	lineSummary?: string,
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
	else if (lineSummary && !running && !isError) details += chrome(` (${lineSummary})`);
	return prefixedText(details, chrome(" └ "), "   ");
}

/**
 * A failed row whose output is hidden gets its reason on the status line. When
 * the output shows, expanded or as a preview, it already says why, and repeating
 * it there only doubles the error.
 */
function hiddenFailureReason(name: string, state: RowState, isError: boolean, output: string): string | undefined {
	return isError && !state.expanded && !state.preview ? summarizeFailure(name, output) : undefined;
}

function renderCallTitle(name: string, theme: Theme, ctx: RenderContext, state: RowState): string {
	return `${renderIndicator(theme, ctx, callStatus(ctx, state))} ${theme.fg("toolTitle", theme.bold(name))}`;
}

function renderFileCall(
	definition: BuiltInDefinition,
	args: ToolArgs,
	theme: Theme,
	ctx: RenderContext,
): Container {
	const name = definition.name as CompactToolName;
	const state = runtime.syncRow(ctx, ctx.state.endedAt === undefined);
	runtime.syncExpansion(state, ctx.expanded, name);
	const callDetails = getCallDetails(name, args);
	const details = callDetails
		? styleMultiline(callDetails, (line) => theme.fg("toolOutput", line))
		: undefined;
	const container = new CachedContainer();
	container.addChild(renderToolCall(renderCallTitle(name, theme, ctx, state), details, theme));
	const arguments_ = getArgumentDetails(name, args);
	if (Object.keys(arguments_).length > 0) container.addChild(renderArguments(arguments_, theme));
	return container;
}

function renderFileBody(
	name: CompactToolName,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	isError: boolean,
): Component | undefined {
	if (isError) return renderOutput(output, theme, isError);
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
	if (name === "edit") {
		const diff = getEditDiff(result);
		const component = diff
			? renderCodeDiff(getEditPatch(result), diff, path, theme, expanded ? {} : { contextLines: PREVIEW_DIFF_CONTEXT_LINES })
			: undefined;
		return component ?? renderOutput(output, theme, isError);
	}
	if (name === "read" && isReadTextResult(result)) {
		const { body, footer } = splitReadFooter(output);
		const startLine = typeof args.offset === "number" ? args.offset : 1;
		return renderCodeView(body, path, theme, { startLine, footer }) ?? renderOutput(output, theme, isError);
	}
	if (name === "write") return renderCodeView(output, path, theme) ?? renderOutput(output, theme, isError);
	return renderOutput(output, theme, isError);
}

function appendFileResult(
	container: Container,
	name: CompactToolName,
	state: RowState,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	theme: Theme,
	isError: boolean,
): void {
	if (!state.expanded && !state.preview) return;
	const component = renderFileBody(name, args, result, output, state.expanded === true, theme, isError);
	if (!component) return;
	container.addChild(state.expanded ? component : limitComponentLines(component, runtime.config.previewLines, theme));
}

function renderFileResult(
	definition: BuiltInDefinition,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
): Component {
	const name = definition.name as CompactToolName;
	const state = runtime.syncRow(ctx, options.isPartial, !options.isPartial);
	runtime.syncExpansion(state, ctx.expanded, name);
	if (canReuseResult(state, result, options, ctx)) return ctx.lastComponent;
	const output = getFileOutput(name, ctx.args, result, ctx.isError);
	const hasEditDiff = name === "edit" && getEditDiff(result).length > 0;
	runtime.setResultAvailable(state, name, hasEditDiff || output.length > 0);
	const container = new CachedContainer();
	appendFileResult(container, name, state, ctx.args, result, output, theme, ctx.isError);
	if (!options.isPartial && !state.resultLineSummaryComputed) {
		state.resultLineSummary = formatResultLineSummary(name, ctx.args, result, output);
		state.resultLineSummaryComputed = true;
	}
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, state.resultLineSummary,
		hiddenFailureReason(name, state, ctx.isError, output), name === "edit" ? countEditChanges(result) : undefined));
	rememberResult(state, result, options, ctx);
	return container;
}

function renderShellCall(
	name: ShellToolName,
	args: BashToolInput,
	theme: Theme,
	ctx: RenderContext<BashToolInput>,
): Component {
	const state = runtime.syncRow(ctx, ctx.state.endedAt === undefined);
	runtime.syncExpansion(state, ctx.expanded, name);
	const command = normalizeLineEndings(args.command ?? "");
	const details = state.expanded
		? styleMultiline(command || "…", (line) => theme.fg("toolOutput", line))
		: theme.fg("toolOutput", summarizeShellCommand(name, command));
	return renderToolCall(renderCallTitle(name, theme, ctx, state), details, theme);
}

function renderShellResult(
	name: ShellToolName,
	result: AgentToolResult<BashToolDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext<BashToolInput>,
): Component {
	const state = runtime.syncRow(ctx, options.isPartial, !options.isPartial);
	runtime.syncExpansion(state, ctx.expanded, name);
	if (canReuseResult(state, result, options, ctx)) return ctx.lastComponent;
	const output = getTextResult(result);
	const failureReason = hiddenFailureReason(name, state, ctx.isError, output);
	runtime.setResultAvailable(state, name, output.length > 0);
	if (!options.isPartial && !state.resultLineSummaryComputed) {
		state.resultLineSummary = formatResultLineSummary(name, ctx.args, result, output);
		state.resultLineSummaryComputed = true;
	}
	if (!state.expanded && !state.preview) {
		const controls = renderControls(theme, state, options.isPartial, ctx.isError, state.resultLineSummary, failureReason);
		rememberResult(state, result, options, ctx);
		return controls;
	}
	const container = new CachedContainer();
	const component = renderOutput(output, theme, ctx.isError);
	if (component) {
		container.addChild(state.expanded ? component : limitComponentLines(component, runtime.config.previewLines, theme));
	}
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, state.resultLineSummary, failureReason));
	rememberResult(state, result, options, ctx);
	return container;
}

function renderCustomCall(name: string, args: ToolArgs, theme: Theme, ctx: RenderContext): Component {
	const state = runtime.syncRow(ctx, ctx.state.endedAt === undefined);
	runtime.syncExpansion(state, ctx.expanded, name);
	const summary = summarizeCustomArguments(args);
	const container = new CachedContainer();
	container.addChild(renderToolCall(
		renderCallTitle(name, theme, ctx, state),
		summary ? theme.fg("toolOutput", summary) : undefined,
		theme,
	));
	if (state.expanded && Object.keys(args).length > 0) container.addChild(renderArguments(args, theme));
	return container;
}

type AuthorResultRenderer = (expanded: boolean) => Component | undefined;

function renderCustomBody(
	output: string,
	expanded: boolean,
	theme: Theme,
	isError: boolean,
	renderAuthorResult: AuthorResultRenderer | undefined,
): Component | undefined {
	if (renderAuthorResult) {
		try {
			const component = renderAuthorResult(expanded);
			if (component) return railComponent(component, theme);
		} catch {
			// A failing third-party renderer degrades to the plain text result.
		}
	}
	return renderOutput(output, theme, isError);
}

function renderCustomResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
	renderAuthorResult: AuthorResultRenderer | undefined,
): Component {
	const state = runtime.syncRow(ctx, options.isPartial, !options.isPartial);
	runtime.syncExpansion(state, ctx.expanded, name);
	if (canReuseResult(state, result, options, ctx)) return ctx.lastComponent;
	const output = getTextResult(result);
	runtime.setResultAvailable(state, name, output.length > 0 || renderAuthorResult !== undefined);
	if (!options.isPartial && !state.resultLineSummaryComputed) {
		state.resultLineSummary = output ? formatResultLineSummary(name, ctx.args, result, output) : undefined;
		state.resultLineSummaryComputed = true;
	}
	const container = new CachedContainer();
	if (state.expanded || state.preview) {
		const body = renderCustomBody(output, state.expanded === true, theme, ctx.isError, renderAuthorResult);
		if (body) container.addChild(state.expanded ? body : limitComponentLines(body, runtime.config.previewLines, theme));
	}
	const failureReason = hiddenFailureReason(name, state, ctx.isError, output);
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, state.resultLineSummary, failureReason));
	rememberResult(state, result, options, ctx);
	return container;
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
		renderCall: (args, theme, ctx) => renderCustomCall(name, (args ?? {}) as ToolArgs, theme, own(ctx)),
		renderResult: (result, options, theme, ctx) => {
			const authorRenderer = author?.renderResult;
			const renderAuthorResult = authorRenderer
				? (expanded: boolean) => {
					authorResult = authorRenderer(result, { ...options, expanded }, theme, { ...ctx, lastComponent: authorResult });
					return authorResult;
				}
				: undefined;
			return renderCustomResult(name, result, options, theme, own(ctx), renderAuthorResult);
		},
	};
}

function resolveCustomRow(row: ToolRow): RowRenderers | undefined {
	const customTools = runtime.config.custom_tools;
	// Built-ins are governed by `tools`: ones left out keep Pi's own renderer.
	if (!customTools.enabled || SUPPORTED_TOOL_SET.has(row.toolName)) return undefined;
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

function createBuiltInDefinition(name: CompactToolName, cwd: string): BuiltInDefinition {
	return toolFactories[name](cwd);
}

function registerFileTool(pi: ExtensionAPI, definition: BuiltInDefinition): void {
	pi.registerTool({
		...definition,
		execute: runtime.createTimedExecute(definition),
		renderShell: "self",
		renderCall: (args: ToolArgs, theme: Theme, ctx: RenderContext) => renderFileCall(definition, args, theme, ctx),
		renderResult: (
			result: AgentToolResult<unknown>,
			options: ToolRenderResultOptions,
			theme: Theme,
			ctx: RenderContext,
		) => renderFileResult(definition, result, options, theme, ctx),
	} as ToolDefinition<any, any, RowState>);
}

function registerShellTool(pi: ExtensionAPI, definition: BuiltInDefinition): void {
	const name = definition.name as ShellToolName;
	pi.registerTool({
		...definition,
		execute: runtime.createTimedExecute(definition),
		renderShell: "self",
		renderCall: (args: BashToolInput, theme: Theme, ctx: RenderContext<BashToolInput>) =>
			renderShellCall(name, args, theme, ctx),
		renderResult: (
			result: AgentToolResult<BashToolDetails | undefined>,
			options: ToolRenderResultOptions,
			theme: Theme,
			ctx: RenderContext<BashToolInput>,
		) => renderShellResult(name, result, options, theme, ctx),
	} as ToolDefinition<any, BashToolDetails | undefined, RowState>);
}

function registerTools(pi: ExtensionAPI, cwd: string): void {
	const enabledTools = new Set(runtime.config.tools);
	for (const name of registeredTools) {
		// Pi exposes no unregister API, so restoring a disabled tool means re-registering
		// the built-in definition to release this extension's renderers.
		if (!enabledTools.has(name)) pi.registerTool(createBuiltInDefinition(name, cwd));
	}
	registeredTools.clear();
	for (const name of runtime.config.tools) {
		const definition = createBuiltInDefinition(name, cwd);
		if (name === "bash" || name === "powershell") registerShellTool(pi, definition);
		else registerFileTool(pi, definition);
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
	const customRowsAvailable = installToolRowPatch();
	setRowResolver(resolveCustomRow);
	let customRowsWarned = false;
	// Register once while the extension runtime is being built. In particular, this
	// makes the overrides available before Pi restores the active tool set on /reload.
	configure(pi, process.cwd());
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") runtime.clearTimings();
		configure(pi, ctx.cwd, ctx.isProjectTrusted());
		if (ctx.mode === "tui") {
			// First, so its input listener sees relayout keys before the thinking controller consumes them.
			viewport.bind(ctx);
			progress.bind(ctx);
			thinkingCycle.bind(ctx);
			silent.bind(ctx, runtime.config.mode, event.reason === "reload");
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
		}
	});
	pi.on("tool_execution_start", (event) => runtime.noteExecutionStart(event.toolCallId));
	pi.on("tool_execution_end", (event) => runtime.noteExecutionEnd(event.toolCallId));
	pi.on("session_shutdown", (event) => {
		thinkingCycle.dispose();
		progress.dispose();
		silent.dispose();
		viewport.dispose();
		runtime.reset(event.reason !== "reload");
	});
}
