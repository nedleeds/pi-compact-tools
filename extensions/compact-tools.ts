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
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";

const MAX_LEVEL = 3;
const CONFIG_FILE = "compact-tools.json";

export interface DurationIndicatorConfig {
	underMs?: number;
	icon: string;
}

export interface CompactToolsConfig {
	previewLines: number;
	spinner: {
		frames: string[];
		intervalMs: number;
	};
	durationIndicators: DurationIndicatorConfig[];
}

export const DEFAULT_CONFIG: CompactToolsConfig = {
	previewLines: 10,
	spinner: {
		frames: ["◐", "◓", "◑", "◒"],
		intervalMs: 120,
	},
	durationIndicators: [
		{ underMs: 1_000, icon: "⚡️" },
		{ underMs: 10_000, icon: "🚀" },
		{ underMs: 30_000, icon: "🔥" },
		{ icon: "☕" },
	],
};

let config = DEFAULT_CONFIG;

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

function parseDurationIndicators(value: unknown): DurationIndicatorConfig[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const rules: DurationIndicatorConfig[] = [];
	let previousLimit = 0;
	for (const [index, item] of value.entries()) {
		if (!isObject(item) || typeof item.icon !== "string" || item.icon.length === 0) return undefined;
		const isLast = index === value.length - 1;
		if (isLast && item.underMs === undefined) rules.push({ icon: item.icon });
		else if (isIntegerInRange(item.underMs, previousLimit + 1, Number.MAX_SAFE_INTEGER)) {
			previousLimit = item.underMs;
			rules.push({ underMs: item.underMs, icon: item.icon });
		} else return undefined;
	}
	return rules.at(-1)?.underMs === undefined ? rules : undefined;
}

function mergeConfig(base: CompactToolsConfig, value: unknown, path: string): CompactToolsConfig {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warnConfig(path, "expected a JSON object; using previous values");
		return base;
	}
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
	return { previewLines, spinner, durationIndicators };
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

export function loadConfig(cwd?: string, projectTrusted = false): CompactToolsConfig {
	const globalPath = join(getAgentDir(), CONFIG_FILE);
	let loaded = mergeConfig(DEFAULT_CONFIG, readConfig(globalPath), globalPath);
	if (!cwd || !projectTrusted) return loaded;
	const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	loaded = mergeConfig(loaded, readConfig(projectPath), projectPath);
	return loaded;
}

const SPINNING_ROWS_KEY = Symbol.for("pi.compact-tools.spinning-rows");
const globalState = globalThis as typeof globalThis & { [SPINNING_ROWS_KEY]?: Set<RowState> };
for (const staleState of globalState[SPINNING_ROWS_KEY] ?? []) {
	if (staleState.timer) clearInterval(staleState.timer);
}
const spinningRows = new Set<RowState>();
globalState[SPINNING_ROWS_KEY] = spinningRows;

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
	const normalized = output.trimEnd();
	if (!normalized) return [];
	return normalized.split("\n").length > config.previewLines ? [2, 3] : [2];
}

function stopSpinner(state: RowState): void {
	if (state.timer) clearInterval(state.timer);
	state.timer = undefined;
	spinningRows.delete(state);
}

function syncSpinner(state: RowState, running: boolean, invalidate: () => void): void {
	if (!running) {
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

function syncTiming(state: RowState, executionStarted: boolean, running: boolean): void {
	if ((executionStarted || running) && state.startedAt === undefined) state.startedAt = Date.now();
	if (!running && state.startedAt !== undefined && state.endedAt === undefined) {
		state.endedAt = Date.now();
	}
}

function syncRow(ctx: RenderContext, running = ctx.isPartial): RowState {
	const state = ctx.state;
	syncTiming(state, ctx.executionStarted, running);
	syncSpinner(state, running, ctx.invalidate);
	return state;
}

function resetUiState(): void {
	for (const state of [...spinningRows]) stopSpinner(state);
}

function renderIndicator(theme: Theme, state: RowState, running: boolean, isError: boolean): string {
	if (!running) return theme.fg(isError ? "error" : "success", isError ? "⊗" : "●");

	const frame = config.spinner.frames[state.frame ?? 0] ?? config.spinner.frames[0] ?? "◐";
	return theme.fg("muted", frame);
}

function formatDuration(state: RowState): string | undefined {
	if (state.startedAt === undefined) return undefined;
	const elapsedMs = (state.endedAt ?? Date.now()) - state.startedAt;
	return `${(elapsedMs / 1000).toFixed(1)}s`;
}

function durationIndicator(state: RowState): string | undefined {
	if (state.startedAt === undefined || state.endedAt === undefined) return undefined;
	const elapsedMs = state.endedAt - state.startedAt;
	return config.durationIndicators.find((rule) => rule.underMs === undefined || elapsedMs < rule.underMs)?.icon;
}

function renderControls(theme: Theme, state: RowState, running: boolean, isError: boolean): Text {
	const duration = formatDuration(state);
	const levels = state.availableLevels ?? [0, 1];
	const expandable = levels.length > 1;
	const atLastLevel = state.level === levels.at(-1);
	const action = expandable
		? `${theme.italic("ctrl+o")} ${atLastLevel ? "to collapse" : "for more"}`
		: undefined;
	const indicator = !running && !isError ? durationIndicator(state) : undefined;
	const status = running
		? duration
		: `${indicator ? `${indicator} ` : ""}${isError ? "Failed" : "Done"}${duration ? ` in ${duration}` : ""}`;
	const details = [status, action].filter(Boolean).join(", ");
	return new Text(`  ${theme.fg("dim", details)}`, 0, 0);
}

function firstLine(value: string, maxLength = 100): string {
	const line = value.split("\n")[0] ?? "";
	return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function getTextResult(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trimEnd();
}

function withoutLeadingBlankLines(component: Component): Component {
	return {
		render(width: number) {
			const lines = component.render(width);
			const firstContentLine = lines.findIndex((line) => visibleWidth(line.trim()) > 0);
			return firstContentLine < 0 ? [] : lines.slice(firstContentLine);
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
	const normalized = output.trimEnd();
	if (!normalized) return undefined;

	const lines = normalized.split("\n");
	const shown = level >= MAX_LEVEL ? lines : lines.slice(0, config.previewLines);
	let text = shown.map((line) => `  ${line}`).join("\n");
	if (shown.length < lines.length) text += `\n  … ${lines.length - shown.length} more lines`;
	return new Text(styleToolOutput(text, theme, isError), 0, 0);
}

function getPathArg(args: ToolArgs): string {
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? firstLine(value) : "";
}

function getFileArgumentDetails(name: string, args: ToolArgs): ToolArgs {
	const omitted = new Set(["path", "file_path"]);
	if (name === "write") omitted.add("content");
	return Object.fromEntries(Object.entries(args).filter(([key, value]) => !omitted.has(key) && value !== undefined));
}

function renderArguments(args: ToolArgs, theme: Theme): Text {
	const json = JSON.stringify(args, null, 2) ?? "{}";
	const text = json
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
	return new Text(theme.fg("toolOutput", text), 0, 0);
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
	if (isError || name === "read") return getTextResult(result);
	if (name === "write") return String(args.content ?? "");
	return "";
}

function renderFileCall(
	definition: BuiltInDefinition,
	args: ToolArgs,
	theme: Theme,
	ctx: RenderContext,
): Container {
	const state = syncRow(ctx);
	const level = advanceLevel(state, ctx.expanded);
	const path = getPathArg(args);
	const argumentDetails = getFileArgumentDetails(definition.name, args);
	let text = `${renderIndicator(theme, state, ctx.isPartial, ctx.isError)} `;
	text += theme.fg("toolTitle", theme.bold(definition.name));
	if (path) text += ` ${theme.fg("toolOutput", path)}`;

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
			container.addChild(withoutLeadingBlankLines(state.originalResultComponent));
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
	const state = syncRow(ctx, options.isPartial);
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

function registerFileTool(pi: ExtensionAPI, definition: BuiltInDefinition): void {
	const tool = {
		...definition,
		renderShell: "self" as const,
		renderCall: createFileCallRenderer(definition),
		renderResult: createFileResultRenderer(definition),
	};
	// Built-in file schemas are intentionally erased at this shared renderer boundary.
	pi.registerTool(tool as ToolDefinition<any, any, RowState>);
}

function renderBashCall(args: BashToolInput, theme: Theme, ctx: RenderContext<BashToolInput>): Text {
	const state = syncRow(ctx);
	const level = advanceLevel(state, ctx.expanded);
	const command = args.command ?? "";
	const displayedCommand = level >= 1 ? command : firstLine(command);
	let text = `${renderIndicator(theme, state, ctx.isPartial, ctx.isError)} `;
	text += `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("toolOutput", displayedCommand)}`;
	if (level >= 1 && args.timeout) text += theme.fg("dim", ` (timeout: ${args.timeout}s)`);
	return new Text(text, 1, 0);
}

function renderBashResult(
	result: AgentToolResult<BashToolDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext<BashToolInput>,
): Component {
	const state = syncRow(ctx, options.isPartial);
	const output = getTextResult(result);
	const hasDetailedCall = (ctx.args.command ?? "").includes("\n") || ctx.args.timeout !== undefined;
	setAvailableLevels(state, [0, ...(hasDetailedCall ? [1] : []), ...getOutputLevels(output)]);
	const level = state.level ?? 0;
	if (level < 2) return renderControls(theme, state, options.isPartial, ctx.isError);

	const container = new Container();
	const preview = renderPreview(output, level, theme, ctx.isError);
	if (preview) container.addChild(preview);
	else container.addChild(new Text(theme.fg("dim", options.isPartial ? "  …" : "  (no output)"), 0, 0));
	container.addChild(renderControls(theme, state, options.isPartial, ctx.isError));
	return container;
}

function registerBashTool(pi: ExtensionAPI, cwd: string): void {
	const original = createBashToolDefinition(cwd);
	pi.registerTool<typeof original.parameters, BashToolDetails | undefined, RowState>({
		...original,
		renderShell: "self",
		renderCall: renderBashCall,
		renderResult: renderBashResult,
	});
}

function registerBuiltInTools(pi: ExtensionAPI, cwd: string): void {
	registerFileTool(pi, createReadToolDefinition(cwd));
	registerFileTool(pi, createEditToolDefinition(cwd));
	registerFileTool(pi, createWriteToolDefinition(cwd));
	registerBashTool(pi, cwd);
}

function applyConfig(pi: ExtensionAPI, cwd: string, projectTrusted: boolean): void {
	resetUiState();
	config = loadConfig(cwd, projectTrusted);
	registerBuiltInTools(pi, cwd);
}

export default function (pi: ExtensionAPI): void {
	config = loadConfig();
	registerBuiltInTools(pi, process.cwd());
	pi.on("session_start", (_event, ctx) => applyConfig(pi, ctx.cwd, ctx.isProjectTrusted()));
	pi.on("resources_discover", (_event, ctx) => applyConfig(pi, ctx.cwd, ctx.isProjectTrusted()));
	pi.on("session_shutdown", resetUiState);
}
