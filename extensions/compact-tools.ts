import type {
	AgentToolResult,
	BashToolDetails,
	BashToolInput,
	ExtensionAPI,
	ExtensionContext,
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
import { Container } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	HEX_COLOR_PATTERN,
	normalizeLineEndings,
	rgbToAnsi256,
	selectDurationIndicator,
	type DurationIndicatorConfig,
	type RowStatus,
	type ThemeDurationIndicatorColor,
} from "./compact-tools-core.ts";
import { isFullscreenMode, loadConfig } from "./compact-tools-config.ts";
import { classifyToggleInput } from "./compact-tools-input.ts";
import {
	formatReadResultSummary,
	getArgumentDetails,
	getCallDetails,
	getFileOutput,
	getTextResult,
} from "./compact-tools-invocation.ts";
import {
	prefixedText,
	renderArguments,
	renderOutput,
	renderToolCall,
	styleMultiline,
	wrapEditResult,
} from "./compact-tools-layout.ts";
import { ToolRuntime } from "./compact-tools-runtime.ts";
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
let unsubscribeTerminalInput: (() => void) | undefined;

function bindTerminalInput(ctx: ExtensionContext): void {
	unsubscribeTerminalInput?.();
	unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
		const input = classifyToggleInput(data);
		if (!input) return undefined;
		if (input === "release") return { consume: true };
		const result = runtime.toggleTrackedRows();
		if (result) ctx.ui.notify(`Compact tool rows: ${result}`, "info");
		return { consume: true };
	});
}

function spinnerTone(frameIndex: number, frameCount: number): "muted" | "dim" | "border" {
	if (frameCount < 3) return "muted";
	const distanceFromCenter = Math.abs(frameIndex / (frameCount - 1) - 0.5) * 2;
	if (distanceFromCenter < 0.34) return "border";
	return distanceFromCenter < 0.75 ? "dim" : "muted";
}

function callStatus(ctx: RenderContext, state: RowState): RowStatus {
	return classifyCallStatus(ctx.isError, ctx.executionStarted, state.endedAt !== undefined);
}

function renderIndicator(theme: Theme, state: RowState, status: RowStatus): string {
	if (status === "error") return theme.fg("error", "⊗");
	if (status === "success") return theme.fg("success", "●");
	const frames = runtime.config.spinner.frames;
	const frameIndex = state.frame ?? 0;
	return theme.fg(spinnerTone(frameIndex, frames.length), frames[frameIndex] ?? frames[0] ?? "◐");
}

function formatDuration(state: RowState): string | undefined {
	if (state.startedAt === undefined) return undefined;
	return formatDurationMs((state.endedAt ?? Date.now()) - state.startedAt);
}

function durationIndicator(state: RowState): DurationIndicatorConfig | undefined {
	const elapsed = state.startedAt !== undefined && state.endedAt !== undefined
		? state.endedAt - state.startedAt
		: undefined;
	return selectDurationIndicator(runtime.config.durationIndicators, elapsed);
}

function styleDurationIcon(theme: Theme, indicator: DurationIndicatorConfig): string {
	const color = indicator.color ?? "dim";
	if (!HEX_COLOR_PATTERN.test(color)) {
		return theme.fg(color as ThemeDurationIndicatorColor, indicator.icon);
	}
	const red = Number.parseInt(color.slice(1, 3), 16);
	const green = Number.parseInt(color.slice(3, 5), 16);
	const blue = Number.parseInt(color.slice(5, 7), 16);
	const ansi = theme.getColorMode() === "truecolor"
		? `\x1b[38;2;${red};${green};${blue}m`
		: `\x1b[38;5;${rgbToAnsi256(red, green, blue)}m`;
	return `${ansi}${indicator.icon}\x1b[39m`;
}

function renderControls(
	theme: Theme,
	state: RowState,
	running: boolean,
	isError: boolean,
	summary?: string,
): Component {
	const duration = running && !runtime.animatesRows ? undefined : formatDuration(state);
	const indicator = !running && !isError ? durationIndicator(state) : undefined;
	const status = running
		? (duration ?? "Running")
		: `${isError ? "Failed" : "Done"}${duration ? ` in ${duration}` : ""}`;
	let details = indicator
		? `${styleDurationIcon(theme, indicator)} ${theme.fg("borderAccent", status)}`
		: theme.fg("borderAccent", status);
	if (summary) details += theme.fg("borderAccent", ` • ${summary}`);
	if (state.hasResult) {
		const clickAction = state.expanded ? "to hide" : "for result";
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
	runtime.track(ctx, name, state);
	runtime.syncExpansion(state, ctx.expanded, name);
	const callDetails = getCallDetails(name, args);
	const details = callDetails
		? styleMultiline(callDetails, (line) => theme.fg("toolOutput", line))
		: undefined;
	const container = new Container();
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
	if (!state.expanded) return;
	if (definition.name === "edit") {
		if (state.originalResultComponent) container.addChild(wrapEditResult(state.originalResultComponent, theme));
		return;
	}
	const component = renderOutput(output, theme, isError);
	if (component) container.addChild(component);
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
	runtime.track(ctx, name, state);
	const output = getFileOutput(name, ctx.args, result, ctx.isError);
	runtime.setResultAvailable(state, name, name === "edit" || output.length > 0);
	updateEditResult(definition, result, options, theme, ctx, state);
	const container = new Container();
	appendFileResult(container, definition, state, output, theme, ctx.isError);
	const summary = name === "read" && !ctx.isError ? formatReadResultSummary(result) : undefined;
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, summary));
	return container;
}

function renderShellCall(
	name: ShellToolName,
	args: BashToolInput,
	theme: Theme,
	ctx: RenderContext<BashToolInput>,
): Component {
	const state = runtime.syncRow(ctx, ctx.state.endedAt === undefined);
	runtime.track(ctx, name, state);
	runtime.syncExpansion(state, ctx.expanded, name);
	const command = normalizeLineEndings(args.command ?? "") || "…";
	const details = styleMultiline(command, (line) => theme.fg("toolOutput", line));
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
	runtime.track(ctx, name, state);
	const output = getTextResult(result);
	runtime.setResultAvailable(state, name, output.length > 0);
	if (!state.expanded) return renderControls(theme, state, options.isPartial, ctx.isError);
	const container = new Container();
	const component = renderOutput(output, theme, ctx.isError);
	if (component) container.addChild(component);
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError));
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
	runtime.configure(loadConfig(cwd, projectTrusted), isFullscreenMode());
	registerTools(pi, cwd ?? process.cwd());
}

export default function compactTools(pi: ExtensionAPI): void {
	configure(pi);
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") runtime.clearTimings();
		configure(pi, ctx.cwd, ctx.isProjectTrusted());
		bindTerminalInput(ctx);
	});
	pi.on("resources_discover", (_event, ctx) => configure(pi, ctx.cwd, ctx.isProjectTrusted()));
	pi.on("session_shutdown", (event) => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		runtime.reset(event.reason !== "reload");
	});
}
