/** Compact rendering and shared status indicators for built-in tools. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
	CONFIG_DIR_NAME,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	classifyCallStatus,
	formatDurationMs,
	HEX_COLOR_PATTERN,
	normalizeLineEndings,
	parseDurationIndicators,
	rgbToAnsi256,
	selectDurationIndicator,
	type DurationIndicatorConfig,
	type RowStatus,
	type ThemeDurationIndicatorColor,
} from "./compact-tools-core.ts";

const MAX_LEVEL = 3;
const CONFIG_FILE = "compact-tools.json";
const SUPPORTED_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;
const SUPPORTED_TOOL_SET = new Set<string>(SUPPORTED_TOOLS);

type CompactToolName = (typeof SUPPORTED_TOOLS)[number];

export interface CompactToolsConfig {
	tools: CompactToolName[];
	previewLines: number;
	spinner: {
		frames: string[];
		intervalMs: number;
	};
	durationIndicators: DurationIndicatorConfig[];
}

export const DEFAULT_CONFIG: CompactToolsConfig = {
	tools: ["read", "write", "edit", "bash"],
	previewLines: 10,
	spinner: {
		frames: ["◐", "◓", "◑", "◒"],
		intervalMs: 120,
	},
	durationIndicators: [
		{ underMs: 1_000, icon: "⚡️", color: "warning" },
		{ underMs: 10_000, icon: "🔥", color: "#D95C3F" },
		{ underMs: 30_000, icon: "○", color: "#79C0FF" },
		{ icon: "⏳", color: "#D2A8FF" },
	],
};

let config = DEFAULT_CONFIG;
let animateRows = false;
const registeredCompactTools = new Set<CompactToolName>();

interface RowState {
	level?: number;
	availableLevels?: number[];
	lastExpanded?: boolean;
	frame?: number;
	startedAt?: number;
	endedAt?: number;
	timer?: ReturnType<typeof setInterval>;
	originalResultComponent?: Component;
}

type ToolArgs = Record<string, unknown>;
type BuiltInDefinition = ToolDefinition<any, any, any>;
type BaseRenderContext = Parameters<NonNullable<BuiltInDefinition["renderCall"]>>[2];
type RenderContext<TArgs = ToolArgs> = Omit<BaseRenderContext, "args" | "state"> & {
	args: TArgs;
	state: RowState;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnConfig(path: string, message: string): void {
	console.error(`[compact-tools] ${path}: ${message}`);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function parseTools(value: unknown, path: string): CompactToolName[] | undefined {
	if (!Array.isArray(value)) {
		warnConfig(path, "tools must be an array; using previous values");
		return undefined;
	}
	const valid = value.filter((item): item is CompactToolName => typeof item === "string" && SUPPORTED_TOOL_SET.has(item));
	const invalid = value.filter((item) => typeof item !== "string" || !SUPPORTED_TOOL_SET.has(item));
	if (invalid.length > 0) warnConfig(path, `ignoring unsupported tools: ${invalid.map(String).join(", ")}`);
	return [...new Set(valid)];
}

function mergeConfig(base: CompactToolsConfig, value: unknown, path: string): CompactToolsConfig {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warnConfig(path, "expected a JSON object; using previous values");
		return base;
	}
	const tools = value.tools === undefined ? base.tools : (parseTools(value.tools, path) ?? base.tools);
	const previewValue = value.previewLines;
	const validPreviewLines = isIntegerInRange(previewValue, 1, 1_000);
	const previewLines = validPreviewLines ? previewValue : base.previewLines;
	if (previewValue !== undefined && !validPreviewLines) {
		warnConfig(path, "previewLines must be an integer from 1 to 1000; using previous value");
	}
	const spinner = parseSpinnerConfig(base.spinner, value.spinner, path);
	const durationIndicators = parseDurationIndicators(value.durationIndicators) ?? base.durationIndicators;
	if (value.durationIndicators !== undefined && durationIndicators === base.durationIndicators) {
		warnConfig(path, "invalid durationIndicators; using previous values");
	}
	return { tools, previewLines, spinner, durationIndicators };
}

function parseSpinnerConfig(
	base: CompactToolsConfig["spinner"],
	value: unknown,
	path: string,
): CompactToolsConfig["spinner"] {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warnConfig(path, "spinner must be an object; using previous values");
		return base;
	}
	const framesValue = value.frames;
	const intervalValue = value.intervalMs;
	const validFrames = isNonEmptyStringArray(framesValue);
	const validInterval = isIntegerInRange(intervalValue, 40, 5_000);
	if (framesValue !== undefined && !validFrames) warnConfig(path, "spinner.frames must be a non-empty string array");
	if (intervalValue !== undefined && !validInterval) warnConfig(path, "spinner.intervalMs must be 40–5000");
	return {
		frames: validFrames ? framesValue : base.frames,
		intervalMs: validInterval ? intervalValue : base.intervalMs,
	};
}

function readConfig(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warnConfig(path, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

function getConfiguredTuiMode(): "regular" | "fullscreen" {
	for (let index = 0; index < process.argv.length; index++) {
		const argument = process.argv[index];
		if (argument === "--tui-mode") {
			const value = process.argv[index + 1];
			if (value === "regular" || value === "fullscreen") return value;
		}
		if (argument?.startsWith("--tui-mode=")) {
			const value = argument.slice("--tui-mode=".length);
			if (value === "regular" || value === "fullscreen") return value;
		}
	}

	const settings = readConfig(join(getAgentDir(), "settings.json"));
	return isObject(settings) && settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";
}

export function loadConfig(cwd?: string, projectTrusted = false): CompactToolsConfig {
	const globalPath = join(getAgentDir(), CONFIG_FILE);
	let loaded = mergeConfig(DEFAULT_CONFIG, readConfig(globalPath), globalPath);
	if (!cwd || !projectTrusted) return loaded;
	const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	loaded = mergeConfig(loaded, readConfig(projectPath), projectPath);
	return loaded;
}

const SPINNING_ROWS_KEY = Symbol.for("pi.compact-tools.spinning-rows");
const EXECUTION_TIMINGS_KEY = Symbol.for("pi.compact-tools.execution-timings");
type ExecutionTiming = { startedAt: number; endedAt?: number };
const globalState = globalThis as typeof globalThis & {
	[SPINNING_ROWS_KEY]?: Set<RowState>;
	[EXECUTION_TIMINGS_KEY]?: Map<string, ExecutionTiming>;
};
for (const staleState of globalState[SPINNING_ROWS_KEY] ?? []) {
	if (staleState.timer) clearInterval(staleState.timer);
}
const spinningRows = new Set<RowState>();
const executionTimings = globalState[EXECUTION_TIMINGS_KEY] ?? new Map<string, ExecutionTiming>();
globalState[SPINNING_ROWS_KEY] = spinningRows;
globalState[EXECUTION_TIMINGS_KEY] = executionTimings;

function advanceLevel(state: RowState, expanded: boolean): number {
	state.level ??= 0;
	if (state.lastExpanded === undefined) {
		state.lastExpanded = expanded;
		return state.level;
	}
	if (state.lastExpanded !== expanded) {
		state.lastExpanded = expanded;
		const levels = state.availableLevels ?? [0, 1];
		const index = levels.indexOf(state.level);
		state.level = levels[(index + 1) % levels.length] ?? 0;
	}
	return state.level;
}

function setAvailableLevels(state: RowState, levels: number[]): void {
	state.availableLevels = levels;
	if (!levels.includes(state.level ?? 0)) state.level = 0;
}

function getOutputLevels(output: string): number[] {
	const normalized = normalizeLineEndings(output).trimEnd();
	if (!normalized) return [];
	return normalized.split("\n").length > config.previewLines ? [2, 3] : [2];
}

function stopSpinner(state: RowState): void {
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
	spinningRows.delete(state);
}

function syncSpinner(state: RowState, running: boolean, invalidate: () => void): void {
	// Regular mode cannot safely redraw a transcript row after it has scrolled
	// above the viewport. Keep active rows static there to avoid full transcript
	// redraws and duplicated-looking terminal output.
	if (!running || !animateRows || config.spinner.frames.length < 2) {
		stopSpinner(state);
		return;
	}
	if (state.timer) return;

	state.frame ??= 0;
	state.timer = setInterval(() => {
		state.frame = ((state.frame ?? 0) + 1) % config.spinner.frames.length;
		try {
			invalidate();
		} catch {
			stopSpinner(state);
		}
	}, config.spinner.intervalMs);
	state.timer.unref?.();
	spinningRows.add(state);
}

function syncTiming(state: RowState, callStarted: boolean, finished: boolean): void {
	if (callStarted && state.startedAt === undefined) state.startedAt = Date.now();
	if (finished && state.startedAt !== undefined && state.endedAt === undefined) {
		state.endedAt = Date.now();
	}
}

function restoreExecutionTiming(state: RowState, toolCallId: string): boolean {
	const timing = executionTimings.get(toolCallId);
	if (!timing) return false;
	state.startedAt = timing.startedAt;
	state.endedAt = timing.endedAt;
	return timing.endedAt !== undefined;
}

function persistExecutionTiming(state: RowState, toolCallId: string): void {
	if (state.startedAt === undefined) return;
	const timing = executionTimings.get(toolCallId) ?? { startedAt: state.startedAt };
	timing.startedAt = state.startedAt;
	if (state.endedAt !== undefined) timing.endedAt = state.endedAt;
	executionTimings.set(toolCallId, timing);
	if (executionTimings.size <= 2_000) return;
	const oldestToolCallId = executionTimings.keys().next().value;
	if (oldestToolCallId !== undefined) executionTimings.delete(oldestToolCallId);
}

function syncRow(
	ctx: RenderContext,
	running = ctx.executionStarted && ctx.state.endedAt === undefined,
	finished = false,
): RowState {
	const state = ctx.state;
	if (restoreExecutionTiming(state, ctx.toolCallId)) running = false;
	const callStarted = !ctx.argsComplete || ctx.executionStarted || running;
	syncTiming(state, callStarted, finished);
	persistExecutionTiming(state, ctx.toolCallId);
	syncSpinner(state, running, ctx.invalidate);
	return state;
}

function resetUiState(clearTimings = false): void {
	for (const state of [...spinningRows]) stopSpinner(state);
	if (clearTimings) executionTimings.clear();
}

function spinnerTone(frameIndex: number, frameCount: number): "muted" | "dim" | "border" {
	if (frameCount < 3) return "muted";
	const position = frameIndex / (frameCount - 1);
	const distanceFromCenter = Math.abs(position - 0.5) * 2;
	if (distanceFromCenter < 0.34) return "border";
	if (distanceFromCenter < 0.75) return "dim";
	return "muted";
}

function resolveCallStatus(ctx: RenderContext, state: RowState): RowStatus {
	return classifyCallStatus(ctx.isError, ctx.executionStarted, state.endedAt !== undefined);
}

function renderIndicator(theme: Theme, state: RowState, status: RowStatus): string {
	if (status === "error") return theme.fg("error", "⊗");
	if (status === "success") return theme.fg("success", "●");
	// A new pending or running row starts at frame zero, then shares the same animation.
	const frameIndex = state.frame ?? 0;
	const frame = config.spinner.frames[frameIndex] ?? config.spinner.frames[0] ?? "◐";
	return theme.fg(spinnerTone(frameIndex, config.spinner.frames.length), frame);
}

function formatDuration(state: RowState): string | undefined {
	if (state.startedAt === undefined) return undefined;
	return formatDurationMs((state.endedAt ?? Date.now()) - state.startedAt);
}

function durationIndicator(state: RowState): DurationIndicatorConfig | undefined {
	// Reloading extensions recreates row state, so already-completed rows no longer
	// have timing data. Keep their configured indicator visible using the first rule.
	const elapsedMs = state.startedAt !== undefined && state.endedAt !== undefined
		? state.endedAt - state.startedAt
		: undefined;
	return selectDurationIndicator(config.durationIndicators, elapsedMs);
}

function parseHexColor(color: string): [number, number, number] {
	return [
		Number.parseInt(color.slice(1, 3), 16),
		Number.parseInt(color.slice(3, 5), 16),
		Number.parseInt(color.slice(5, 7), 16),
	];
}

function styleDurationIcon(theme: Theme, indicator: DurationIndicatorConfig): string {
	const color = indicator.color ?? "dim";
	if (!HEX_COLOR_PATTERN.test(color)) {
		return theme.fg(color as ThemeDurationIndicatorColor, indicator.icon);
	}
	const [red, green, blue] = parseHexColor(color);
	const ansi = theme.getColorMode() === "truecolor"
		? `\x1b[38;2;${red};${green};${blue}m`
		: `\x1b[38;5;${rgbToAnsi256(red, green, blue)}m`;
	return `${ansi}${indicator.icon}\x1b[39m`;
}

function renderControls(theme: Theme, state: RowState, running: boolean, isError: boolean): Text {
	const duration = running && !animateRows ? undefined : formatDuration(state);
	const levels = state.availableLevels ?? [0, 1];
	const expandable = levels.length > 1;
	const atLastLevel = state.level === levels.at(-1);
	const action = expandable
		? `${theme.italic("ctrl+o")} ${atLastLevel ? "to collapse" : "for more"}`
		: undefined;
	const indicator = !running && !isError ? durationIndicator(state) : undefined;
	const status = running
		? (duration ?? "Running")
		: `${isError ? "Failed" : "Done"}${duration ? ` in ${duration}` : ""}`;
	let details = indicator
		? `${styleDurationIcon(theme, indicator)} ${theme.fg("borderAccent", status)}`
		: theme.fg("borderAccent", status);
	if (action) details += theme.fg("borderAccent", `, ${action}`);
	return new Text(`${theme.fg("border", " └─ ")}${details}`, 0, 0);
}

function firstLine(value: string, maxLength = 100): string {
	const line = normalizeLineEndings(value).split("\n")[0] ?? "";
	return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function getTextResult(result: AgentToolResult<unknown>): string {
	const text = result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	return normalizeLineEndings(text).trimEnd();
}

function withoutLeadingBlankLines(component: Component, theme: Theme): Component {
	return {
		render(width: number) {
			const lines = component.render(Math.max(1, width - 4));
			const firstContentLine = lines.findIndex((line) => visibleWidth(line.trim()) > 0);
			const prefix = theme.fg("border", " │  ");
			return firstContentLine < 0 ? [] : lines.slice(firstContentLine).map((line) => `${prefix}${line}`);
		},
		invalidate() {
			component.invalidate?.();
		},
	};
}

function styleToolOutput(text: string, theme: Theme, isError: boolean): string {
	const color = isError ? "error" : "toolOutput";
	return text
		.split(/(⚡️?)/u)
		.map((part) => theme.fg(!isError && part.startsWith("⚡") ? "warning" : color, part))
		.join("");
}

function renderPreview(output: string, level: number, theme: Theme, isError: boolean): Text | undefined {
	const normalized = normalizeLineEndings(output).trimEnd();
	if (!normalized) return undefined;

	const lines = normalized.split("\n");
	const shown = level >= MAX_LEVEL ? lines : lines.slice(0, config.previewLines);
	const prefix = theme.fg("border", " │  ");
	let text = shown.map((line) => `${prefix}${styleToolOutput(line, theme, isError)}`).join("\n");
	if (shown.length < lines.length) {
		text += `\n${prefix}${theme.fg("dim", `… ${lines.length - shown.length} more lines`)}`;
	}
	return new Text(text, 0, 0);
}

function getPathArg(args: ToolArgs): string {
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? firstLine(value) : "";
}

function getCallDetails(name: string, args: ToolArgs): string {
	const path = getPathArg(args) || (name === "grep" || name === "find" || name === "ls" ? "." : "");
	const pattern = typeof args.pattern === "string" ? firstLine(args.pattern) : "…";
	if (name === "grep") return `/${pattern}/ in ${path}`;
	if (name === "find") return `${pattern} in ${path}`;
	return path;
}

function getFileArgumentDetails(name: string, args: ToolArgs): ToolArgs {
	if (name === "edit") return {};
	const omitted = new Set(["path", "file_path"]);
	if (name === "write") omitted.add("content");
	if (name === "grep" || name === "find") omitted.add("pattern");
	return Object.fromEntries(Object.entries(args).filter(([key, value]) => !omitted.has(key) && value !== undefined));
}

function renderArguments(args: ToolArgs, theme: Theme): Text {
	const json = JSON.stringify(args, null, 2) ?? "{}";
	const prefix = theme.fg("border", " │  ");
	const text = json
		.split("\n")
		.map((line) => `${prefix}${theme.fg("toolOutput", line)}`)
		.join("\n");
	return new Text(text, 0, 0);
}

function callOriginalEditResult(
	definition: BuiltInDefinition,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
	state: RowState,
	level: number,
): void {
	if (definition.name !== "edit" || !definition.renderResult) return;
	state.originalResultComponent = definition.renderResult(
		result,
		{ ...options, expanded: level >= MAX_LEVEL },
		theme,
		{ ...ctx, state: {}, lastComponent: state.originalResultComponent },
	);
}

function getFileOutput(name: string, args: ToolArgs, result: AgentToolResult<unknown>, isError: boolean): string {
	if (isError || name === "read" || name === "grep" || name === "find" || name === "ls") {
		return getTextResult(result);
	}
	if (name === "write") return String(args.content ?? "");
	return "";
}

function renderFileCall(
	definition: BuiltInDefinition,
	args: ToolArgs,
	theme: Theme,
	ctx: RenderContext,
): Container {
	// Animate and time from the first rendered call so large write/edit calls
	// represent the full lifecycle, including streamed arguments and filesystem work.
	const state = syncRow(ctx, ctx.state.endedAt === undefined);
	// syncRow may restore a completed timing after /reload. Recompute from the
	// synchronized state so a stale local value cannot leave the spinner visible.
	const status = resolveCallStatus(ctx, state);
	const level = advanceLevel(state, ctx.expanded);
	const callDetails = getCallDetails(definition.name, args);
	const argumentDetails = getFileArgumentDetails(definition.name, args);
	let text = `${renderIndicator(theme, state, status)} `;
	text += theme.fg("toolTitle", theme.bold(definition.name));
	if (callDetails) text += ` ${theme.fg("toolOutput", callDetails)}`;

	const container = new Container();
	container.addChild(new Text(text, 1, 0));
	if (level >= 1 && Object.keys(argumentDetails).length > 0) {
		container.addChild(renderArguments(argumentDetails, theme));
	}
	return container;
}

function addFileResultPreview(
	container: Container,
	definition: BuiltInDefinition,
	state: RowState,
	output: string,
	level: number,
	theme: Theme,
	isError: boolean,
): void {
	if (level < 2) return;
	if (definition.name === "edit") {
		if (state.originalResultComponent) {
			container.addChild(withoutLeadingBlankLines(state.originalResultComponent, theme));
		}
		return;
	}
	const preview = renderPreview(output, level, theme, isError);
	if (preview) container.addChild(preview);
}

function renderFileResult(
	definition: BuiltInDefinition,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
): Container {
	const state = syncRow(ctx, options.isPartial, !options.isPartial);
	const output = getFileOutput(definition.name, ctx.args, result, ctx.isError);
	const hasArguments = Object.keys(getFileArgumentDetails(definition.name, ctx.args)).length > 0;
	const levels = definition.name === "edit" ? [0, 2] : [0, ...(hasArguments ? [1] : []), ...getOutputLevels(output)];
	setAvailableLevels(state, levels);

	const level = state.level ?? 0;
	callOriginalEditResult(definition, result, options, theme, ctx, state, level);
	const container = new Container();
	addFileResultPreview(container, definition, state, output, level, theme, ctx.isError);
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError));
	return container;
}

function createFileCallRenderer(definition: BuiltInDefinition) {
	return (args: ToolArgs, theme: Theme, ctx: RenderContext) => renderFileCall(definition, args, theme, ctx);
}

function createFileResultRenderer(definition: BuiltInDefinition) {
	return (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, ctx: RenderContext) =>
		renderFileResult(definition, result, options, theme, ctx);
}

type TimedExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;

function createTimedExecute(definition: BuiltInDefinition): TimedExecute {
	const execute = definition.execute as TimedExecute;
	return async (...args: any[]) => {
		const toolCallId = typeof args[0] === "string" ? args[0] : undefined;
		const startedAt = (toolCallId ? executionTimings.get(toolCallId)?.startedAt : undefined) ?? Date.now();
		if (toolCallId && !executionTimings.has(toolCallId)) executionTimings.set(toolCallId, { startedAt });
		try {
			return await execute.apply(definition, args);
		} finally {
			const endedAt = Date.now();
			const timing = toolCallId ? executionTimings.get(toolCallId) : undefined;
			if (timing) timing.endedAt = endedAt;
		}
	};
}

function registerFileTool(pi: ExtensionAPI, definition: BuiltInDefinition): void {
	const tool = {
		...definition,
		execute: createTimedExecute(definition),
		renderShell: "self" as const,
		renderCall: createFileCallRenderer(definition),
		renderResult: createFileResultRenderer(definition),
	};
	// Built-in file schemas are intentionally erased at this shared renderer boundary.
	pi.registerTool(tool as ToolDefinition<any, any, RowState>);
}

function renderShellCall(
	name: "bash" | "powershell",
	args: BashToolInput,
	theme: Theme,
	ctx: RenderContext<BashToolInput>,
): Text {
	const state = syncRow(ctx, ctx.state.endedAt === undefined);
	// A completed timing can be restored inside syncRow. Derive the rendered
	// status afterward so completion immediately replaces the spinner.
	const status = resolveCallStatus(ctx, state);
	const level = advanceLevel(state, ctx.expanded);
	const command = normalizeLineEndings(args.command ?? "");
	const displayedCommand = (level >= 1 ? command : firstLine(command)) || "…";
	let text = `${renderIndicator(theme, state, status)} `;
	text += `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("toolOutput", displayedCommand)}`;
	return new Text(text, 1, 0);
}

function renderShellResult(
	result: AgentToolResult<BashToolDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext<BashToolInput>,
): Component {
	const state = syncRow(ctx, options.isPartial, !options.isPartial);
	const output = getTextResult(result);
	const hasDetailedCall = /\r\n?|\n/.test(ctx.args.command ?? "");
	setAvailableLevels(state, [0, ...(hasDetailedCall ? [1] : []), ...getOutputLevels(output)]);
	const level = state.level ?? 0;
	if (level < 2) return renderControls(theme, state, options.isPartial, ctx.isError);

	const container = new Container();
	const preview = renderPreview(output, level, theme, ctx.isError);
	if (preview) container.addChild(preview);
	else {
		const prefix = theme.fg("border", " │  ");
		const message = theme.fg("dim", options.isPartial ? "…" : "(no output)");
		container.addChild(new Text(`${prefix}${message}`, 0, 0));
	}
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError));
	return container;
}

function createBuiltInDefinition(name: CompactToolName, cwd: string): BuiltInDefinition {
	switch (name) {
		case "read": return createReadToolDefinition(cwd);
		case "write": return createWriteToolDefinition(cwd);
		case "edit": return createEditToolDefinition(cwd);
		case "bash": return createBashToolDefinition(cwd);
		case "powershell": return createPowerShellToolDefinition(cwd);
		case "grep": return createGrepToolDefinition(cwd);
		case "find": return createFindToolDefinition(cwd);
		case "ls": return createLsToolDefinition(cwd);
	}
}

function registerShellTool(pi: ExtensionAPI, definition: BuiltInDefinition): void {
	pi.registerTool({
		...definition,
		execute: createTimedExecute(definition),
		renderShell: "self",
		renderCall: (args: BashToolInput, theme: Theme, ctx: RenderContext<BashToolInput>) =>
			renderShellCall(definition.name as "bash" | "powershell", args, theme, ctx),
		renderResult: renderShellResult,
	} as ToolDefinition<any, BashToolDetails | undefined, RowState>);
}

function registerBuiltInTools(pi: ExtensionAPI, cwd: string): void {
	for (const name of registeredCompactTools) {
		if (!config.tools.includes(name)) pi.registerTool(createBuiltInDefinition(name, cwd));
	}
	registeredCompactTools.clear();
	for (const name of config.tools) {
		const definition = createBuiltInDefinition(name, cwd);
		if (name === "bash" || name === "powershell") registerShellTool(pi, definition);
		else registerFileTool(pi, definition);
		registeredCompactTools.add(name);
	}
}

function applyConfig(pi: ExtensionAPI, cwd: string, projectTrusted: boolean): void {
	resetUiState();
	animateRows = getConfiguredTuiMode() === "fullscreen";
	config = loadConfig(cwd, projectTrusted);
	registerBuiltInTools(pi, cwd);
}

export default function (pi: ExtensionAPI): void {
	animateRows = getConfiguredTuiMode() === "fullscreen";
	config = loadConfig();
	registerBuiltInTools(pi, process.cwd());
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") executionTimings.clear();
		applyConfig(pi, ctx.cwd, ctx.isProjectTrusted());
	});
	pi.on("resources_discover", (_event, ctx) => applyConfig(pi, ctx.cwd, ctx.isProjectTrusted()));
	pi.on("session_shutdown", (event) => resetUiState(event.reason !== "reload"));
}
