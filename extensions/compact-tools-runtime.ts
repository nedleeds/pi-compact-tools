import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./compact-tools-config.ts";
import type {
	BuiltInDefinition,
	CompactToolName,
	CompactToolsConfig,
	RenderContext,
	RowState,
} from "./compact-tools-types.ts";

const MAX_TRACKED_ROWS = 2_000;
const SPINNING_ROWS_KEY = Symbol.for("pi.compact-tools.spinning-rows");
const EXECUTION_TIMINGS_KEY = Symbol.for("pi.compact-tools.execution-timings");

type ExecutionTiming = { startedAt: number; endedAt?: number };
type TrackedRow = { state: RowState; name: CompactToolName; invalidate: () => void };
type TimedExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;
type SharedState = typeof globalThis & {
	[SPINNING_ROWS_KEY]?: Set<RowState>;
	[EXECUTION_TIMINGS_KEY]?: Map<string, ExecutionTiming>;
};

export class ToolRuntime {
	private configValue = DEFAULT_CONFIG;
	private configRevision: object = {};
	private animateRows = false;
	private readonly spinningRows = new Set<RowState>();
	private readonly executionTimings: Map<string, ExecutionTiming>;
	private readonly trackedRows = new Map<string, TrackedRow>();

	constructor() {
		const shared = globalThis as SharedState;
		for (const state of shared[SPINNING_ROWS_KEY] ?? []) {
			if (state.timer) clearInterval(state.timer);
		}
		this.executionTimings = shared[EXECUTION_TIMINGS_KEY] ?? new Map<string, ExecutionTiming>();
		shared[SPINNING_ROWS_KEY] = this.spinningRows;
		shared[EXECUTION_TIMINGS_KEY] = this.executionTimings;
	}

	get config(): CompactToolsConfig {
		return this.configValue;
	}

	get animatesRows(): boolean {
		return this.animateRows;
	}

	configure(config: CompactToolsConfig, animateRows: boolean): void {
		this.reset(false);
		this.configValue = config;
		this.animateRows = animateRows;
		this.configRevision = {};
	}

	clearTimings(): void {
		this.executionTimings.clear();
	}

	reset(clearTimings: boolean): void {
		for (const state of this.spinningRows) this.stopSpinner(state);
		this.trackedRows.clear();
		if (clearTimings) this.clearTimings();
	}

	track(ctx: RenderContext, name: CompactToolName, state: RowState): void {
		this.trackedRows.delete(ctx.toolCallId);
		this.trackedRows.set(ctx.toolCallId, { state, name, invalidate: ctx.invalidate });
		if (this.trackedRows.size <= MAX_TRACKED_ROWS) return;
		const oldest = this.trackedRows.keys().next().value;
		if (oldest !== undefined) this.trackedRows.delete(oldest);
	}

	toggleTrackedRows(): "expanded" | "collapsed" | undefined {
		const rows: TrackedRow[] = [];
		for (const row of this.trackedRows.values()) {
			if (this.configValue.auto_compact[row.name] && row.state.hasResult) rows.push(row);
		}
		if (rows.length === 0) return undefined;
		const expand = rows.some(({ state }) => !state.expanded);
		for (const { state, invalidate } of rows) {
			state.expanded = expand;
			invalidate();
		}
		return expand ? "expanded" : "collapsed";
	}

	syncExpansion(state: RowState, hostExpanded: boolean, name: CompactToolName): boolean {
		const initialized = this.initializeExpansion(state, name);
		if (initialized || state.lastHostExpanded === undefined) {
			state.lastHostExpanded = hostExpanded;
		} else if (state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = !state.expanded;
		}
		return state.expanded ?? false;
	}

	setResultAvailable(state: RowState, name: CompactToolName, available: boolean): void {
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
		this.persistTiming(state, ctx.toolCallId);
		this.syncSpinner(state, running, ctx.invalidate);
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

	private initializeExpansion(state: RowState, name: CompactToolName): boolean {
		if (state.configRevision === this.configRevision) return false;
		state.configRevision = this.configRevision;
		state.expanded = !this.configValue.auto_compact[name];
		return true;
	}

	private stopSpinner(state: RowState): void {
		if (state.timer) clearInterval(state.timer);
		state.timer = undefined;
		this.spinningRows.delete(state);
	}

	private syncSpinner(state: RowState, running: boolean, invalidate: () => void): void {
		const spinner = this.configValue.spinner;
		if (!running || !this.animateRows || spinner.frames.length < 2) {
			this.stopSpinner(state);
			return;
		}
		if (state.timer) return;
		state.frame ??= 0;
		state.timer = setInterval(() => {
			state.frame = ((state.frame ?? 0) + 1) % spinner.frames.length;
			try {
				invalidate();
			} catch {
				this.stopSpinner(state);
			}
		}, spinner.intervalMs);
		state.timer.unref?.();
		this.spinningRows.add(state);
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
