import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;
export const SUPPORTED_TOOL_SET = new Set<string>(SUPPORTED_TOOLS);

export type CompactToolName = (typeof SUPPORTED_TOOLS)[number];
export type ShellToolName = "bash" | "powershell";
export type ToolArgs = Record<string, unknown>;
export type BuiltInDefinition = ToolDefinition<any, any, any>;

export const DISPLAY_MODES = ["normal", "silent"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export interface CustomToolsConfig {
	/** Render tools registered by other extensions compactly as well. */
	enabled: boolean;
	auto_compact: boolean;
	exclude: string[];
}

export interface CompactToolsConfig {
	mode: DisplayMode;
	tools: CompactToolName[];
	auto_compact: Record<CompactToolName, boolean>;
	custom_tools: CustomToolsConfig;
	previewLines: number;
}

export interface RowState {
	expanded?: boolean;
	preview?: boolean;
	hasResult?: boolean;
	lastHostExpanded?: boolean;
	configRevision?: object;
	startedAt?: number;
	endedAt?: number;
	resultLineSummary?: string;
	resultLineSummaryComputed?: boolean;
	lastResultContent?: unknown;
	lastResultDetails?: unknown;
	lastResultPartial?: boolean;
	lastResultExpanded?: boolean;
	lastResultPreview?: boolean;
	lastResultError?: boolean;
	lastResultConfigRevision?: object;
}

type BaseRenderContext = Parameters<NonNullable<BuiltInDefinition["renderCall"]>>[2];
export type RenderContext<TArgs = ToolArgs> = Omit<BaseRenderContext, "args" | "state"> & {
	args: TArgs;
	state: RowState;
};
