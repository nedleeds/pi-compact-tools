import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseDurationIndicators } from "./compact-tools-core.ts";
import {
	SUPPORTED_TOOL_SET,
	type CompactToolName,
	type CompactToolsConfig,
} from "./compact-tools-types.ts";

const CONFIG_FILE = "compact-tools.json";
type JsonObject = Record<string, unknown>;

export const DEFAULT_CONFIG: CompactToolsConfig = {
	tools: ["read", "write", "edit", "bash"],
	auto_compact: {
		read: true,
		write: true,
		edit: false,
		bash: true,
		powershell: true,
		grep: true,
		find: true,
		ls: true,
	},
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

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(path: string, message: string): void {
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
		warn(path, "tools must be an array; using previous values");
		return undefined;
	}
	const tools: CompactToolName[] = [];
	const invalid: unknown[] = [];
	for (const item of value) {
		if (typeof item === "string" && SUPPORTED_TOOL_SET.has(item)) tools.push(item as CompactToolName);
		else invalid.push(item);
	}
	if (invalid.length > 0) warn(path, `ignoring unsupported tools: ${invalid.map(String).join(", ")}`);
	return [...new Set(tools)];
}

function parseAutoCompact(
	base: CompactToolsConfig["auto_compact"],
	value: unknown,
	path: string,
): CompactToolsConfig["auto_compact"] {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warn(path, "auto_compact must be an object; using previous values");
		return base;
	}
	const result = { ...base };
	for (const [name, enabled] of Object.entries(value)) {
		if (!SUPPORTED_TOOL_SET.has(name)) {
			warn(path, `ignoring unsupported auto_compact tool: ${name}`);
		} else if (typeof enabled !== "boolean") {
			warn(path, `auto_compact.${name} must be true or false; using previous value`);
		} else {
			result[name as CompactToolName] = enabled;
		}
	}
	return result;
}

function parseSpinner(
	base: CompactToolsConfig["spinner"],
	value: unknown,
	path: string,
): CompactToolsConfig["spinner"] {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warn(path, "spinner must be an object; using previous values");
		return base;
	}
	const frames = value.frames;
	const intervalMs = value.intervalMs;
	const validFrames = isNonEmptyStringArray(frames);
	const validInterval = isIntegerInRange(intervalMs, 40, 5_000);
	if (frames !== undefined && !validFrames) warn(path, "spinner.frames must be a non-empty string array");
	if (intervalMs !== undefined && !validInterval) warn(path, "spinner.intervalMs must be 40–5000");
	return {
		frames: validFrames ? frames : base.frames,
		intervalMs: validInterval ? intervalMs : base.intervalMs,
	};
}

export function mergeConfig(base: CompactToolsConfig, value: unknown, path: string): CompactToolsConfig {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warn(path, "expected a JSON object; using previous values");
		return base;
	}
	const tools = value.tools === undefined ? base.tools : (parseTools(value.tools, path) ?? base.tools);
	const auto_compact = parseAutoCompact(base.auto_compact, value.auto_compact, path);
	const spinner = parseSpinner(base.spinner, value.spinner, path);
	const parsedIndicators = value.durationIndicators === undefined
		? undefined
		: parseDurationIndicators(value.durationIndicators);
	if (value.durationIndicators !== undefined && !parsedIndicators) {
		warn(path, "invalid durationIndicators; using previous values");
	}
	return {
		tools,
		auto_compact,
		spinner,
		durationIndicators: parsedIndicators ?? base.durationIndicators,
	};
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warn(path, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

export function loadConfig(cwd?: string, projectTrusted = false): CompactToolsConfig {
	const globalPath = join(getAgentDir(), CONFIG_FILE);
	const globalConfig = mergeConfig(DEFAULT_CONFIG, readJson(globalPath), globalPath);
	if (!cwd || !projectTrusted) return globalConfig;
	const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	return mergeConfig(globalConfig, readJson(projectPath), projectPath);
}

export function isFullscreenMode(argv = process.argv): boolean {
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--tui-mode") return argv[index + 1] === "fullscreen";
		if (argument?.startsWith("--tui-mode=")) return argument.slice("--tui-mode=".length) === "fullscreen";
	}
	const settings = readJson(join(getAgentDir(), "settings.json"));
	return isObject(settings) && settings.tuiMode === "fullscreen";
}
