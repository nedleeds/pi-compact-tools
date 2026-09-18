import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { getCallDetails } from "./compact-tools-invocation.ts";
import type { CompactToolsConfig, ToolArgs } from "./compact-tools-types.ts";

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

function indicatorFrames(config: CompactToolsConfig, theme: Theme): string[] {
	return config.spinner.frames.map((frame, index, frames) => {
		const position = frames.length < 3 ? 0.5 : index / (frames.length - 1);
		const distance = Math.abs(position - 0.5) * 2;
		const tone = distance < 0.34 ? "accent" : distance < 0.75 ? "dim" : "muted";
		return theme.fg(tone, frame);
	});
}

/** Owns Pi's single working row so animation remains continuous across thinking and tool execution. */
export class ProgressController {
	private context: ExtensionContext | undefined;
	private readonly activeTools = new Map<string, string>();

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
			this.context?.ui.setWorkingMessage();
		});
	}

	bind(ctx: ExtensionContext, config: CompactToolsConfig): void {
		this.context = ctx;
		this.activeTools.clear();
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator({
			frames: indicatorFrames(config, ctx.ui.theme),
			intervalMs: config.spinner.intervalMs,
		});
	}

	dispose(): void {
		this.activeTools.clear();
		this.context?.ui.setWorkingMessage();
		this.context?.ui.setWorkingIndicator();
		this.context = undefined;
	}

	private setMessage(message: string): void {
		this.context?.ui.setWorkingMessage(message);
	}
}
