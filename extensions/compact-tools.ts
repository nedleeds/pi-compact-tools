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
	normalizeLineEndings,
	type RowStatus,
} from "./compact-tools-core.ts";
import { loadConfig } from "./compact-tools-config.ts";
import {
	formatResultLineSummary,
	getArgumentDetails,
	getCallDetails,
	getFileOutput,
	getTextResult,
} from "./compact-tools-invocation.ts";
import {
	CachedContainer,
	limitComponentLines,
	prefixedText,
	renderArguments,
	renderOutput,
	renderToolCall,
	styleMultiline,
	wrapEditResult,
} from "./compact-tools-layout.ts";
import { ProgressController } from "./compact-tools-progress.ts";
import { ToolRuntime } from "./compact-tools-runtime.ts";
import { ThinkingCycleController } from "./compact-tools-thinking.ts";
import type {
	BuiltInDefinition,
	CompactToolName,
	RenderContext,
	RowState,
	ShellToolName,
	ToolArgs,
} from "./compact-tools-types.ts";

const runtime = new ToolRuntime();
const registeredTools = new Set<CompactToolName>();

function callStatus(ctx: RenderContext, state: RowState): RowStatus {
	return classifyCallStatus(ctx.isError, ctx.executionStarted, state.endedAt !== undefined);
}

function renderIndicator(theme: Theme, _state: RowState, status: RowStatus): string {
	if (status === "error") return theme.fg("error", "●");
	if (status === "success") return theme.fg("success", "●");
	return theme.fg("accent", runtime.config.spinner.frames[0] ?? "◐");
}

function formatDuration(state: RowState): string | undefined {
	if (state.startedAt === undefined) return undefined;
	return formatDurationMs((state.endedAt ?? Date.now()) - state.startedAt);
}

function renderControls(
	theme: Theme,
	state: RowState,
	running: boolean,
	isError: boolean,
	lineSummary?: string,
): Component {
	const duration = running ? undefined : formatDuration(state);
	const status = running
		? (duration ?? "Running")
		: `${isError ? "Failed" : "Done"}${duration ? ` in ${duration}` : ""}`;
	let details = theme.fg("borderAccent", status);
	if (lineSummary && !running) details += theme.fg("borderAccent", ` (${lineSummary})`);
	if (state.hasResult) {
		const clickAction = state.expanded ? "to hide" : state.preview ? "to expand" : "for result";
		details += theme.fg(
			"borderAccent",
			`, ${theme.italic("ctrl+o")} toggle all • ${theme.italic("click")} ${clickAction}`,
		);
	}
	return prefixedText(details, theme.fg("border", " └─ "), "    ");
}

function renderCallTitle(name: string, theme: Theme, ctx: RenderContext, state: RowState): string {
	return `${renderIndicator(theme, state, callStatus(ctx, state))} ${theme.fg("toolTitle", theme.bold(name))}`;
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

function updateEditResult(
	definition: BuiltInDefinition,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
	state: RowState,
): void {
	if (definition.name !== "edit" || !definition.renderResult) return;
	state.originalResultComponent = definition.renderResult(
		result,
		{ ...options, expanded: state.expanded ?? false },
		theme,
		{ ...ctx, state: {}, lastComponent: state.originalResultComponent },
	);
}

function appendFileResult(
	container: Container,
	definition: BuiltInDefinition,
	state: RowState,
	output: string,
	theme: Theme,
	isError: boolean,
): void {
	if (!state.expanded && !state.preview) return;
	const component = definition.name === "edit"
		? state.originalResultComponent ? wrapEditResult(state.originalResultComponent, theme) : undefined
		: renderOutput(output, theme, isError);
	if (!component) return;
	container.addChild(state.expanded ? component : limitComponentLines(component, runtime.config.previewLines, theme));
}

function renderFileResult(
	definition: BuiltInDefinition,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
): Container {
	const name = definition.name as CompactToolName;
	const state = runtime.syncRow(ctx, options.isPartial, !options.isPartial);
	runtime.syncExpansion(state, ctx.expanded, name);
	const output = getFileOutput(name, ctx.args, result, ctx.isError);
	runtime.setResultAvailable(state, name, name === "edit" || output.length > 0);
	updateEditResult(definition, result, options, theme, ctx, state);
	const container = new CachedContainer();
	appendFileResult(container, definition, state, output, theme, ctx.isError);
	if (!options.isPartial && !state.resultLineSummaryComputed) {
		state.resultLineSummary = formatResultLineSummary(name, ctx.args, result, output);
		state.resultLineSummaryComputed = true;
	}
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, state.resultLineSummary));
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
	const command = normalizeLineEndings(args.command ?? "") || "…";
	const details = styleMultiline(command, (line) => theme.fg("toolOutput", line));
	const component = renderToolCall(renderCallTitle(name, theme, ctx, state), details, theme);
	return state.expanded ? component : limitComponentLines(component, runtime.config.previewLines, theme);
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
	const output = getTextResult(result);
	runtime.setResultAvailable(state, name, output.length > 0);
	if (!options.isPartial && !state.resultLineSummaryComputed) {
		state.resultLineSummary = formatResultLineSummary(name, ctx.args, result, output);
		state.resultLineSummaryComputed = true;
	}
	if (!state.expanded && !state.preview) {
		return renderControls(theme, state, options.isPartial, ctx.isError, state.resultLineSummary);
	}
	const container = new CachedContainer();
	const component = renderOutput(output, theme, ctx.isError);
	if (component) {
		container.addChild(state.expanded ? component : limitComponentLines(component, runtime.config.previewLines, theme));
	}
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, state.resultLineSummary));
	return container;
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
	runtime.configure(loadConfig(cwd, projectTrusted));
	registerTools(pi, cwd ?? process.cwd());
}

export default function compactTools(pi: ExtensionAPI): void {
	const thinkingCycle = new ThinkingCycleController(pi);
	const progress = new ProgressController(pi);
	configure(pi);
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") runtime.clearTimings();
		configure(pi, ctx.cwd, ctx.isProjectTrusted());
		progress.bind(ctx, runtime.config);
		thinkingCycle.bind(ctx);
	});
	pi.on("resources_discover", (_event, ctx) => {
		configure(pi, ctx.cwd, ctx.isProjectTrusted());
		progress.bind(ctx, runtime.config);
	});
	pi.on("session_shutdown", (event) => {
		thinkingCycle.dispose();
		progress.dispose();
		runtime.reset(event.reason !== "reload");
	});
}
