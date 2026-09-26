import { ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";

// Symbol.for keys are shared by every evaluation of this module. The prototype is
// Pi's and outlives a /reload, so the patch is installed once and always asks the
// most recently loaded extension instance, through the shared slot, what to render.
const RESOLVER_KEY = Symbol.for("pi-compact-tools.custom.resolver");
const PATCHED_KEY = Symbol.for("pi-compact-tools.custom.patched");
const ROUTED_METHODS = ["getCallRenderer", "getResultRenderer", "getRenderShell", "hasRendererDefinition"] as const;

type AnyToolDefinition = ToolDefinition<any, any, any>;

/** The fields of Pi's tool row that decide which renderer is used. */
export interface ToolRow {
	toolName: string;
	toolCallId?: string;
	toolDefinition?: AnyToolDefinition;
}

export interface RowRenderers {
	renderCall: NonNullable<AnyToolDefinition["renderCall"]>;
	renderResult: NonNullable<AnyToolDefinition["renderResult"]>;
}

export type RowResolver = (row: ToolRow) => RowRenderers | undefined;

type RoutedPrototype = Record<(typeof ROUTED_METHODS)[number], (...args: unknown[]) => unknown>;
type ResolverSlot = typeof globalThis & { [RESOLVER_KEY]?: RowResolver };

export function setRowResolver(resolver: RowResolver | undefined): void {
	(globalThis as ResolverSlot)[RESOLVER_KEY] = resolver;
}

/**
 * Pi routes every renderer lookup on a tool row through these four methods, so
 * answering them is enough to give any tool, whichever extension registered it,
 * compact renderers. Returns false when the host no longer has that shape.
 */
export function patchToolRows(prototype: object | undefined): boolean {
	if (!prototype) return false;
	const routed = prototype as RoutedPrototype;
	if (!ROUTED_METHODS.every((method) => typeof routed[method] === "function")) return false;
	if (Object.hasOwn(prototype, PATCHED_KEY)) return true;
	// Decided once per row: Pi picks the row's container from these answers in its
	// constructor, so a row must never switch renderers after it is built. /reload
	// rebuilds the transcript, so config changes still reach every row.
	const decisions = new WeakMap<object, RowRenderers | null>();
	const resolve = (row: ToolRow): RowRenderers | undefined => {
		let renderers = decisions.get(row);
		if (renderers === undefined) {
			try {
				renderers = (globalThis as ResolverSlot)[RESOLVER_KEY]?.(row) ?? null;
			} catch {
				renderers = null;
			}
			decisions.set(row, renderers);
		}
		return renderers ?? undefined;
	};
	const original = Object.fromEntries(ROUTED_METHODS.map((method) => [method, routed[method]])) as RoutedPrototype;
	routed.getCallRenderer = function (this: ToolRow, ...args) {
		return resolve(this)?.renderCall ?? original.getCallRenderer.apply(this, args);
	};
	routed.getResultRenderer = function (this: ToolRow, ...args) {
		return resolve(this)?.renderResult ?? original.getResultRenderer.apply(this, args);
	};
	routed.getRenderShell = function (this: ToolRow, ...args) {
		return resolve(this) ? "self" : original.getRenderShell.apply(this, args);
	};
	routed.hasRendererDefinition = function (this: ToolRow, ...args) {
		return resolve(this) ? true : original.hasRendererDefinition.apply(this, args);
	};
	Object.defineProperty(prototype, PATCHED_KEY, { value: true });
	return true;
}

export function installToolRowPatch(): boolean {
	return patchToolRows(ToolExecutionComponent?.prototype);
}
