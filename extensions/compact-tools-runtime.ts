import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./compact-tools-config.ts";
import { isSilent } from "./compact-tools-silent.ts";
import {
	SUPPORTED_TOOL_SET,
	type BuiltInDefinition,
	type CompactToolName,
	type CompactToolsConfig,
	type RenderContext,
	type RowState,
} from "./compact-tools-types.ts";

const MAX_TRACKED_ROWS = 2_000;
const INDICATOR_INTERVAL_MS = 45;
const EXECUTION_TIMINGS_KEY = Symbol.for("pi.compact-tools.execution-timings");

type ExecutionTiming = { startedAt: number; endedAt?: number };
type TimedExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;
type SharedState = typeof globalThis & {
	[EXECUTION_TIMINGS_KEY]?: Map<string, ExecutionTiming>;
};

export class ToolRuntime {
	private configValue = DEFAULT_CONFIG;
	private configRevision: object = {};
	private readonly executionTimings: Map<string, ExecutionTiming>;
	private readonly indicatorInvalidators = new Map<string, () => void>();
	private indicatorFrame = 0;
	private indicatorTimer: ReturnType<typeof setInterval> | undefined;

	constructor() {
		const shared = globalThis as SharedState;
		this.executionTimings = shared[EXECUTION_TIMINGS_KEY] ?? new Map<string, ExecutionTiming>();
		shared[EXECUTION_TIMINGS_KEY] = this.executionTimings;
	}

	get config(): CompactToolsConfig {
		return this.configValue;
	}

	configure(config: CompactToolsConfig): void {
		this.configValue = config;
		this.configRevision = {};
	}

	clearTimings(): void {
		this.executionTimings.clear();
	}

	reset(clearTimings: boolean): void {
		this.stopIndicators();
		if (clearTimings) this.clearTimings();
	}

	syncIndicator(toolCallId: string, running: boolean, invalidate: () => void): number {
		if (!running) {
			this.removeIndicator(toolCallId);
			return 0;
		}
		this.indicatorInvalidators.set(toolCallId, invalidate);
		if (!this.indicatorTimer) {
			this.indicatorTimer = setInterval(() => {
				this.indicatorFrame++;
				// Silent mode hides tool rows; repainting the screen for them would be pure cost.
				if (isSilent()) return;
				for (const requestRender of this.indicatorInvalidators.values()) requestRender();
			}, INDICATOR_INTERVAL_MS);
			this.indicatorTimer.unref?.();
		}
		return this.indicatorFrame;
	}

	syncExpansion(state: RowState, hostExpanded: boolean, name: string): boolean {
		const initialized = this.initializeExpansion(state, name, hostExpanded);
		if (!initialized && state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = hostExpanded;
			// A non-auto-compacted row collapses back to its bounded preview. Hiding it
			// here removes the clicked row from under the pointer, so the next click can
			// accidentally hit the Thinking block that moved into the same coordinates.
			state.preview = !hostExpanded && !this.autoCompact(name);
		}
		return state.expanded ?? false;
	}

	setResultAvailable(state: RowState, name: string, available: boolean): void {
		this.initializeExpansion(state, name);
		state.hasResult = available;
	}

	syncRow(
		ctx: RenderContext,
		running = ctx.executionStarted && ctx.state.endedAt === undefined,
		finished = false,
	): RowState {
		const state = ctx.state;
		if (this.restoreTiming(state, ctx.toolCallId)) running = false;
		const started = !ctx.argsComplete || ctx.executionStarted || running;
		if (started && state.startedAt === undefined) state.startedAt = Date.now();
		if (finished && state.startedAt !== undefined && state.endedAt === undefined) state.endedAt = Date.now();
		if (finished) this.removeIndicator(ctx.toolCallId);
		this.persistTiming(state, ctx.toolCallId);
		return state;
	}

	createTimedExecute(definition: BuiltInDefinition): TimedExecute {
		const execute = definition.execute as TimedExecute;
		return async (...args: any[]) => {
			const toolCallId = typeof args[0] === "string" ? args[0] : undefined;
			const startedAt = (toolCallId ? this.executionTimings.get(toolCallId)?.startedAt : undefined) ?? Date.now();
			if (toolCallId && !this.executionTimings.has(toolCallId)) {
				this.executionTimings.set(toolCallId, { startedAt });
			}
			try {
				return await execute.apply(definition, args);
			} finally {
				const timing = toolCallId ? this.executionTimings.get(toolCallId) : undefined;
				if (timing) timing.endedAt = Date.now();
			}
		};
	}

	private removeIndicator(toolCallId: string): void {
		this.indicatorInvalidators.delete(toolCallId);
		if (this.indicatorInvalidators.size > 0 || !this.indicatorTimer) return;
		clearInterval(this.indicatorTimer);
		this.indicatorTimer = undefined;
		this.indicatorFrame = 0;
	}

	private stopIndicators(): void {
		if (this.indicatorTimer) clearInterval(this.indicatorTimer);
		this.indicatorTimer = undefined;
		this.indicatorInvalidators.clear();
		this.indicatorFrame = 0;
	}

	/** Built-ins follow their own auto_compact entry; every other tool shares the custom_tools policy. */
	private autoCompact(name: string): boolean {
		return SUPPORTED_TOOL_SET.has(name)
			? this.configValue.auto_compact[name as CompactToolName]
			: this.configValue.custom_tools.auto_compact;
	}

	private initializeExpansion(state: RowState, name: string, hostExpanded = false): boolean {
		if (state.configRevision === this.configRevision) return false;
		state.configRevision = this.configRevision;
		state.lastHostExpanded = hostExpanded;
		state.expanded = hostExpanded;
		state.preview = !hostExpanded && !this.autoCompact(name);
		return true;
	}

	private restoreTiming(state: RowState, toolCallId: string): boolean {
		const timing = this.executionTimings.get(toolCallId);
		if (!timing) return false;
		state.startedAt = timing.startedAt;
		state.endedAt = timing.endedAt;
		return timing.endedAt !== undefined;
	}

	private persistTiming(state: RowState, toolCallId: string): void {
		if (state.startedAt === undefined) return;
		const timing = this.executionTimings.get(toolCallId) ?? { startedAt: state.startedAt };
		timing.startedAt = state.startedAt;
		if (state.endedAt !== undefined) timing.endedAt = state.endedAt;
		this.executionTimings.set(toolCallId, timing);
		if (this.executionTimings.size <= MAX_TRACKED_ROWS) return;
		const oldest = this.executionTimings.keys().next().value;
		if (oldest !== undefined) this.executionTimings.delete(oldest);
	}
}
