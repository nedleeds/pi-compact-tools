import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export const SUPPORTED_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;
export const SUPPORTED_TOOL_SET = new Set<string>(SUPPORTED_TOOLS);

export type CompactToolName = (typeof SUPPORTED_TOOLS)[number];
export type ShellToolName = "bash" | "powershell";
export type ToolArgs = Record<string, unknown>;
export type BuiltInDefinition = ToolDefinition<any, any, any>;

export interface CompactToolsConfig {
	tools: CompactToolName[];
	auto_compact: Record<CompactToolName, boolean>;
	spinner: {
		frames: string[];
		intervalMs: number;
	};
}

export interface RowState {
	expanded?: boolean;
	hasResult?: boolean;
	lastHostExpanded?: boolean;
	configRevision?: object;
	frame?: number;
	startedAt?: number;
	endedAt?: number;
	timer?: ReturnType<typeof setInterval>;
	originalResultComponent?: Component;
	resultLineSummary?: string;
	resultLineSummaryComputed?: boolean;
}

type BaseRenderContext = Parameters<NonNullable<BuiltInDefinition["renderCall"]>>[2];
export type RenderContext<TArgs = ToolArgs> = Omit<BaseRenderContext, "args" | "state"> & {
	args: TArgs;
	state: RowState;
};
