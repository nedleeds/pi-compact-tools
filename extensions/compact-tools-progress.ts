import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { getCallDetails } from "./compact-tools-invocation.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

const GLOW_INTERVAL_MS = 80;
const GLOW_TAIL = 5;

function progressTarget(toolName: string, args: ToolArgs): string | undefined {
	const fallback = typeof args.command === "string" ? args.command
		: typeof args.path === "string" ? args.path
		: typeof args.pattern === "string" ? args.pattern
		: undefined;
	const detail = getCallDetails(toolName, args) || fallback;
	if (!detail) return undefined;
	return stripTerminalSequences(truncateToWidth(detail.replace(/\s+/gu, " ").trim(), 72, "…"));
}

export function formatToolProgress(toolName: string, args: ToolArgs): string {
	const target = progressTarget(toolName, args);
	return target ? `${toolName} · ${target}` : toolName;
}

/** Render a sky-blue label with a soft white highlight sweeping left to right. */
export function glowProgressMessage(message: string, frame: number, theme: Theme): string {
	const characters = [...message];
	const center = frame % Math.max(1, characters.length + GLOW_TAIL);
	return characters.map((character, index) => {
		const distance = Math.abs(index - center);
		const color = distance === 0 ? "text"
			: distance === 1 ? "thinkingXhigh"
			: distance === 2 ? "thinkingHigh"
			: "thinkingMax";
		return theme.fg(color, character);
	}).join("");
}

/** Owns Pi's single working row so animation remains continuous across thinking and tool execution. */
export class ProgressController {
	private context: ExtensionContext | undefined;
	private readonly activeTools = new Map<string, string>();
	private message: string | undefined;
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
		this.context = undefined;
	}

	private setMessage(message: string): void {
		if (this.message !== message) {
			this.message = message;
			this.frame = 0;
		}
		this.renderMessage();
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame++;
			this.renderMessage();
		}, GLOW_INTERVAL_MS);
		this.timer.unref?.();
	}

	private renderMessage(): void {
		if (!this.message || !this.context) return;
		this.context.ui.setWorkingMessage(glowProgressMessage(this.message, this.frame, this.context.ui.theme));
	}

	private clearMessage(): void {
		this.stopAnimation();
		this.message = undefined;
		this.frame = 0;
		this.context?.ui.setWorkingMessage();
	}

	private stopAnimation(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
