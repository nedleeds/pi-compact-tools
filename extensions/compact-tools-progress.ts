import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolArgs } from "./compact-tools-types.ts";

const GLOW_INTERVAL_MS = 80;
type Rgb = { r: number; g: number; b: number };

const ANSI_BASIC_RGB: readonly Rgb[] = [
	{ r: 0, g: 0, b: 0 }, { r: 128, g: 0, b: 0 }, { r: 0, g: 128, b: 0 }, { r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 }, { r: 128, g: 0, b: 128 }, { r: 0, g: 128, b: 128 }, { r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 }, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 255 }, { r: 0, g: 255, b: 255 }, { r: 255, g: 255, b: 255 },
];

const TOOL_PROGRESS_MESSAGES: Readonly<Record<string, string>> = {
	read: "Reading file…",
	write: "Writing file…",
	edit: "Editing file…",
	bash: "Running command…",
	powershell: "Running command…",
	grep: "Searching text…",
	find: "Finding files…",
	ls: "Listing files…",
};

function humanizeToolName(toolName: string, args: ToolArgs): string {
	const routedName = (toolName === "mcp" || toolName.startsWith("mcp__")) && typeof args.tool === "string"
		? args.tool
		: toolName;
	const readableName = stripTerminalSequences(routedName)
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/^mcp__/iu, "")
		.replace(/[_-]mcp$/iu, "")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.replace(/([a-z\d])([A-Z])/gu, "$1 $2")
		.replace(/[_-]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return truncateToWidth(readableName, 40, "…");
}

/** Keep the working row calm and private; invocation details remain in the tool card. */
export function formatToolProgress(toolName: string, args: ToolArgs): string {
	const builtInMessage = TOOL_PROGRESS_MESSAGES[toolName];
	if (builtInMessage) return builtInMessage;
	const displayName = humanizeToolName(toolName, args);
	return displayName ? `Using ${displayName}…` : "Running tool…";
}

function ansi256ToRgb(index: number): Rgb {
	if (index < 16) return ANSI_BASIC_RGB[index] ?? { r: 192, g: 192, b: 192 };
	if (index < 232) {
		const value = index - 16;
		const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
		return {
			r: channel(Math.floor(value / 36)),
			g: channel(Math.floor((value % 36) / 6)),
			b: channel(value % 6),
		};
	}
	const gray = 8 + Math.min(23, index - 232) * 10;
	return { r: gray, g: gray, b: gray };
}

function themeColorRgb(theme: Theme, color: "thinkingMax"): Rgb | undefined {
	if (typeof theme.getFgAnsi !== "function") return undefined;
	const ansi = theme.getFgAnsi(color);
	const trueColor = ansi.match(/\[38;2;(\d+);(\d+);(\d+)m/u);
	if (trueColor) return { r: Number(trueColor[1]), g: Number(trueColor[2]), b: Number(trueColor[3]) };
	const indexed = ansi.match(/\[38;5;(\d+)m/u);
	return indexed ? ansi256ToRgb(Number(indexed[1])) : undefined;
}

function interpolateToWhite(base: Rgb, strength: number): Rgb {
	const channel = (value: number) => Math.round(value + (255 - value) * strength);
	return { r: channel(base.r), g: channel(base.g), b: channel(base.b) };
}

function rgbToAnsi256(rgb: Rgb): number {
	let bestIndex = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < 256; index++) {
		const candidate = ansi256ToRgb(index);
		const distance = (rgb.r - candidate.r) ** 2 + (rgb.g - candidate.g) ** 2 + (rgb.b - candidate.b) ** 2;
		if (distance >= bestDistance) continue;
		bestIndex = index;
		bestDistance = distance;
	}
	return bestIndex;
}

function glowRadius(length: number): number {
	return Math.max(2, Math.min(8, Math.ceil(length / 4)));
}

function colorizeRgb(theme: Theme, color: Rgb, character: string): string {
	if (typeof theme.getColorMode === "function" && theme.getColorMode() === "256color") {
		return `\x1b[38;5;${rgbToAnsi256(color)}m${character}\x1b[39m`;
	}
	return `\x1b[38;2;${color.r};${color.g};${color.b}m${character}\x1b[39m`;
}

/** Render a thinking-summary-colored label with a proportional white highlight sweeping left to right. */
export function glowProgressMessage(message: string, frame: number, theme: Theme): string {
	const characters = [...message];
	if (characters.length === 0) return "";
	const radius = glowRadius(characters.length);
	const center = frame % (characters.length + radius * 2) - radius;
	const base = themeColorRgb(theme, "thinkingMax");
	if (!base) {
		return characters.map((character, index) =>
			theme.fg(Math.abs(index - center) < radius ? "mdHeading" : "thinkingMax", character)).join("");
	}
	return characters.map((character, index) => {
		const distance = Math.abs(index - center);
		const strength = Math.max(0, 1 - distance / radius);
		return colorizeRgb(theme, interpolateToWhite(base, strength), character);
	}).join("");
}

function createGlowFrames(message: string, theme: Theme): string[] {
	const length = [...message].length;
	if (length === 0) return [""];
	return Array.from({ length: length + glowRadius(length) * 2 }, (_, frame) =>
		glowProgressMessage(message, frame, theme));
}

/** Owns Pi's single working row so animation remains continuous across thinking and tool execution. */
export class ProgressController {
	private context: ExtensionContext | undefined;
	private readonly activeTools = new Map<string, string>();
	private message: string | undefined;
	private frames: string[] = [];
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(pi: ExtensionAPI) {
		pi.on("agent_start", () => this.setMessage("Thinking…"));
		pi.on("message_update", (event) => {
			const type = event.assistantMessageEvent.type;
			if (type === "thinking_start" || type === "thinking_delta") this.setMessage("Thinking…");
			else if (type === "text_start" || type === "text_delta") this.setMessage("Responding…");
			else if (type === "toolcall_start" || type === "toolcall_delta") this.setMessage("Preparing tools…");
		});
		pi.on("tool_execution_start", (event) => {
			const message = formatToolProgress(event.toolName, event.args ?? {});
			this.activeTools.set(event.toolCallId, message);
			this.setMessage(message);
		});
		pi.on("tool_execution_end", (event) => {
			this.activeTools.delete(event.toolCallId);
			const remaining = [...this.activeTools.values()].at(-1);
			this.setMessage(remaining ?? "Processing results…");
		});
		pi.on("agent_end", () => {
			this.activeTools.clear();
			this.clearMessage();
		});
	}

	bind(ctx: ExtensionContext): void {
		this.stopAnimation();
		this.context = ctx;
		this.activeTools.clear();
		this.message = undefined;
		this.frames = [];
		this.frame = 0;
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator({ frames: [] });
	}

	dispose(): void {
		this.stopAnimation();
		this.activeTools.clear();
		this.context?.ui.setWorkingMessage();
		this.context?.ui.setWorkingIndicator();
		this.message = undefined;
		this.frames = [];
		this.context = undefined;
	}

	private setMessage(message: string): void {
		if (!this.context || (this.message === message && this.timer)) return;
		this.message = message;
		this.frames = createGlowFrames(message, this.context.ui.theme);
		this.frame = 0;
		this.renderMessage();
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame++;
			this.renderMessage();
		}, GLOW_INTERVAL_MS);
		this.timer.unref?.();
	}

	private renderMessage(): void {
		if (!this.message || !this.context || this.frames.length === 0) return;
		this.context.ui.setWorkingMessage(this.frames[this.frame % this.frames.length]);
	}

	private clearMessage(): void {
		this.stopAnimation();
		this.message = undefined;
		this.frames = [];
		this.frame = 0;
		this.context?.ui.setWorkingMessage();
	}

	private stopAnimation(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
