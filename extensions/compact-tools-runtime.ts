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
/**
 * How long a running row may go undrawn before it stops asking for frames. Pi draws
 * every row it shows on every frame, so only a row that left the transcript, or
 * never got its result, goes this long; it asks again the next time it is drawn.
 */
const UNDRAWN_ROW_MS = 1_500;
const EXECUTION_TIMINGS_KEY = Symbol.for("pi.compact-tools.execution-timings");

type ExecutionTiming = { startedAt: number; endedAt?: number };
type Indicator = { invalidate: () => void; drawnAt: number };
type TimedExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;
type SharedState = typeof globalThis & {
	[EXECUTION_TIMINGS_KEY]?: Map<string, ExecutionTiming>;
};

export class ToolRuntime {
	private configValue = DEFAULT_CONFIG;
	private configRevision: object = {};
	private readonly executionTimings: Map<string, ExecutionTiming>;
	private readonly indicators = new Map<string, Indicator>();
	private indicatorFrame = 0;
	private indicatorTimer: ReturnType<typeof setInterval> | undefined;
	/** Pi's frame request, once bound to its terminal; rows then repaint without being rebuilt. */
	private requestRender: (() => void) | undefined;
	/** Whether the agent is working; undefined until the host says, which counts as working. */
	private busy: boolean | undefined;
	/** Counts the agent's runs, so a row knows whether the run it belongs to is still going. */
	private run = 0;
	/**
	 * The run each call's row was first drawn in, for what draws a call without its
	 * row state, such as the group a row is folded into.
	 */
	private readonly callRuns = new Map<string, number>();

	constructor(private readonly clock: () => number = () => performance.now()) {
		const shared = globalThis as SharedState;
		this.executionTimings = shared[EXECUTION_TIMINGS_KEY] ?? new Map<string, ExecutionTiming>();
		shared[EXECUTION_TIMINGS_KEY] = this.executionTimings;
	}

	get config(): CompactToolsConfig {
		return this.configValue;
	}

	/** The shared animation frame of running indicators, for rows drawn outside a tool renderer. */
	get frame(): number {
		return this.indicatorFrame;
	}

	/** When a tool call started and, once it has, ended. */
	timing(toolCallId: string): Readonly<ExecutionTiming> | undefined {
		return this.executionTimings.get(toolCallId);
	}

	configure(config: CompactToolsConfig): void {
		this.configValue = config;
		this.configRevision = {};
	}

	clearTimings(): void {
		this.executionTimings.clear();
		this.callRuns.clear();
	}

	reset(clearTimings: boolean): void {
		this.stopIndicators();
		if (clearTimings) this.clearTimings();
	}

	/**
	 * Bind the animation to Pi's frame requests. A running dot is painted when its
	 * row is drawn, so a frame only has to be asked for, once, however many rows
	 * run. Unbound, each running row is rebuilt to repaint, as Pi does on its own.
	 */
	bindRenderer(requestRender: (() => void) | undefined): void {
		this.requestRender = requestRender;
	}

	/**
	 * The agent started or stopped working. Once it stops nothing can still be
	 * running, so a row that never got its result stops pulsing and waits instead.
	 */
	setBusy(busy: boolean): void {
		if (busy && this.busy !== true) this.run++;
		this.busy = busy;
		if (busy) return;
		const animating = this.indicators.size > 0;
		this.stopIndicators();
		if (animating) this.requestRender?.();
	}

	/**
	 * Whether a row can be running: only while the run it was first drawn in goes
	 * on. A row first drawn while the agent is idle was restored from the session,
	 * and one left without a result when its run ended will never get one; either
	 * way, whatever it did is over.
	 */
	canRun(state: RowState): boolean {
		return this.busy !== false && state.run === this.run;
	}

	/** canRun() for a call by its id; a call no row has drawn yet can run while the agent works. */
	canRunCall(toolCallId: string): boolean {
		const run = this.callRuns.get(toolCallId);
		return this.busy !== false && (run === undefined || run === this.run);
	}

	syncIndicator(toolCallId: string, running: boolean, invalidate: () => void): number {
		if (!running) {
			this.removeIndicator(toolCallId);
			return 0;
		}
		const indicator = this.indicators.get(toolCallId);
		if (indicator) {
			indicator.invalidate = invalidate;
			indicator.drawnAt = this.clock();
		} else {
			this.indicators.set(toolCallId, { invalidate, drawnAt: this.clock() });
		}
		if (!this.indicatorTimer) {
			this.indicatorTimer = setInterval(() => this.tick(), INDICATOR_INTERVAL_MS);
			this.indicatorTimer.unref?.();
		}
		return this.indicatorFrame;
	}

	/**
	 * A running row that is out of sight but still counts, such as one folded into
	 * a group whose line pulses for it, keeps the animation going.
	 */
	keepAnimating(toolCallId: string): void {
		const indicator = this.indicators.get(toolCallId);
		if (indicator) indicator.drawnAt = this.clock();
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

	syncRow(ctx: RenderContext, finished = false): RowState {
		const state = ctx.state;
		if (state.run === undefined) {
			state.run = this.busy === false ? -1 : this.run;
			this.callRuns.set(ctx.toolCallId, state.run);
			if (this.callRuns.size > MAX_TRACKED_ROWS) this.callRuns.delete(this.callRuns.keys().next().value!);
		}
		this.restoreTiming(state, ctx.toolCallId);
		// A row is timed from when it runs, as Pi times its own: the model writing the
		// arguments is not the tool's time. A restored row never ran in front of the
		// reader, so it has no time to measure unless this process timed it before a
		// /reload, and a call that never ran has none either.
		const started = this.canRun(state) && ctx.executionStarted;
		if (started && state.startedAt === undefined) state.startedAt = Date.now();
		if (finished) state.finished = true;
		if (finished && state.startedAt !== undefined && state.endedAt === undefined) state.endedAt = Date.now();
		if (finished) this.removeIndicator(ctx.toolCallId);
		this.persistTiming(state, ctx.toolCallId);
		return state;
	}

	/**
	 * Record when a tool this extension does not wrap starts and ends. Pi reports
	 * both to extensions before it redraws the row, and the row draws its status
	 * dot before its result, so without this a finished custom tool kept the
	 * running dot. Wrapped built-ins already have timings, which are kept.
	 */
	noteExecutionStart(toolCallId: string): void {
		if (!this.executionTimings.has(toolCallId)) this.executionTimings.set(toolCallId, { startedAt: Date.now() });
	}

	noteExecutionEnd(toolCallId: string): void {
		const timing = this.executionTimings.get(toolCallId) ?? { startedAt: Date.now() };
		timing.endedAt ??= Date.now();
		this.executionTimings.set(toolCallId, timing);
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

	private tick(): void {
		this.indicatorFrame++;
		const requestRender = this.requestRender;
		if (requestRender) {
			const oldest = this.clock() - UNDRAWN_ROW_MS;
			for (const [toolCallId, indicator] of this.indicators) {
				if (indicator.drawnAt < oldest) this.removeIndicator(toolCallId);
			}
			if (this.indicators.size === 0) return;
		}
		// Silent mode hides tool rows; repainting the screen for them would be pure cost.
		if (isSilent()) return;
		if (requestRender) {
			requestRender();
			return;
		}
		for (const { invalidate } of this.indicators.values()) invalidate();
	}

	private removeIndicator(toolCallId: string): void {
		this.indicators.delete(toolCallId);
		if (this.indicators.size > 0 || !this.indicatorTimer) return;
		clearInterval(this.indicatorTimer);
		this.indicatorTimer = undefined;
		this.indicatorFrame = 0;
	}

	private stopIndicators(): void {
		if (this.indicatorTimer) clearInterval(this.indicatorTimer);
		this.indicatorTimer = undefined;
		this.indicators.clear();
		this.indicatorFrame = 0;
	}

	/** Built-ins follow their own auto_compact entry; a custom tool its own entry if it has one, else the custom_tools policy. */
	private autoCompact(name: string): boolean {
		return SUPPORTED_TOOL_SET.has(name)
			? this.configValue.auto_compact[name as CompactToolName]
			: this.configValue.auto_compact[name] ?? this.configValue.custom_tools.auto_compact;
	}

	private initializeExpansion(state: RowState, name: string, hostExpanded = false): boolean {
		if (state.configRevision === this.configRevision) return false;
		state.configRevision = this.configRevision;
		state.lastHostExpanded = hostExpanded;
		state.expanded = hostExpanded;
		state.preview = !hostExpanded && !this.autoCompact(name);
		return true;
	}

	private restoreTiming(state: RowState, toolCallId: string): void {
		const timing = this.executionTimings.get(toolCallId);
		if (!timing) return;
		state.startedAt = timing.startedAt;
		state.endedAt = timing.endedAt;
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
