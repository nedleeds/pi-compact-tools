/**
 * Drives rows through Pi's own ToolExecutionComponent in the order Pi drives them,
 * with the animation clock under the test's control.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

export const INDICATOR_INTERVAL_MS = 45;
/** One whole pulse and a frame past it, so the wrap back to the first frame is pinned too. */
export const PULSE_FRAMES = 15;

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "compact-tools-indicator-"));
process.env.COLORTERM = "truecolor";
initTheme("dark", false);
mock.timers.enable({ apis: ["setInterval"] });

let now = 2_000_000;
const realNow = Date.now;
Date.now = () => now;

// The monotonic clock tells a row that is still drawn from one that left the screen.
let monotonic = 1_000;
performance.now = () => monotonic;

/** Move the monotonic clock, which tells how long ago a row was last drawn. */
export function elapse(ms: number): void {
	monotonic += ms;
}

/** Move the pinned wall clock, which durations are measured by. */
export function advance(ms: number): void {
	now += ms;
}

export function restoreClocks(): void {
	Date.now = realNow;
	mock.timers.reset();
}

export function readable(line: string): string {
	return line.replace(/\x1b/gu, "\\e");
}

type Handler = (event: any, ctx?: any) => void;
type Definition = { name: string } & Record<string, unknown>;

export interface Harness {
	definitions: Map<string, Definition>;
	handlers: Map<string, Handler>;
	requestRenders: () => number;
	/** Pi's chat, where grouping looks for rows in the Claude style. */
	chat: { children: unknown[]; render(width: number): string[] };
}

/** Load the extension as Pi does; `tui` binds it to a terminal the way interactive mode would. */
export async function loadExtension(
	config: object,
	options: { tui?: boolean; idle?: boolean; reason?: string } = {},
): Promise<Harness> {
	const { Container } = await import("@earendil-works/pi-tui");
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "compact-tools.json"), JSON.stringify({
		tools: ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"],
		...config,
	}));
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const definitions = new Map<string, Definition>();
	// Every handler an event has, as Pi calls them all.
	const listeners = new Map<string, Handler[]>();
	const handlers = new Map<string, Handler>();
	compactTools({
		on: (name: string, handler: Handler) => {
			const list = listeners.get(name) ?? [];
			list.push(handler);
			listeners.set(name, list);
			handlers.set(name, (event, ctx) => { for (const listener of list) listener(event, ctx); });
		},
		registerTool: (definition: Definition) => definitions.set(definition.name, definition),
		registerMarkdownTransformer: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI);
	let renders = 0;
	const chat = new Container();
	const tui = { children: [{ children: [chat] }], requestRender: () => { renders++; } };
	const ui = new Proxy({} as Record<string, unknown>, {
		get: (_target, key) => {
			if (key === "setWidget") {
				return (_key: string, factory: unknown) => {
					if (typeof factory === "function") factory(tui);
				};
			}
			if (key === "theme") return theme;
			return () => () => {};
		},
	});
	const ctx: Record<string, unknown> = {
		cwd: "/project",
		mode: options.tui ? "tui" : "print",
		isProjectTrusted: () => false,
		ui,
	};
	if (options.idle !== undefined) ctx.isIdle = () => options.idle;
	handlers.get("session_start")!({ reason: options.reason ?? "startup" }, ctx as unknown as ExtensionContext);
	return { definitions, handlers, requestRenders: () => renders, chat };
}

export function shutdown(harness: Harness): void {
	harness.handlers.get("session_shutdown")?.({ reason: "quit" });
}

export function makeRow(name: string, id: string, args: object, definition: object | undefined): ToolExecutionComponent {
	const ui = { requestRender() {} };
	return new ToolExecutionComponent(name, id, args, {}, definition as never, ui as never, "/project");
}

export const text = (value: string, details?: unknown) => ({ content: [{ type: "text" as const, text: value }], details });
const lines = (count: number, label = "line") => Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n");

export type Case = { args: Record<string, unknown>; partial?: ReturnType<typeof text>; success: ReturnType<typeof text>; failure: ReturnType<typeof text> };

export const CASES: Record<string, Case> = {
	read: { args: { path: "src/app.ts" }, success: text(lines(14)), failure: text("ENOENT: no such file or directory") },
	write: { args: { path: "src/new.ts", content: lines(12) }, success: text("Wrote 12 lines"), failure: text("EACCES: permission denied") },
	edit: {
		args: { path: "src/app.ts", edits: [{ oldText: "line 3", newText: "line three" }] },
		success: text("Edited", { diff: "   2 line 2\n-  3 line 3\n+  3 line three\n   4 line 4" }),
		failure: text("oldText not found"),
	},
	bash: {
		args: { command: "cd /project && npm test -- --watch=false" },
		partial: text(lines(3, "out")),
		success: text(lines(9, "out")),
		failure: text("npm ERR! missing script\n\nCommand exited with code 1"),
	},
	powershell: {
		args: { command: "Get-ChildItem -Recurse | Select-String TODO" },
		success: text(lines(4, "match")),
		failure: text("Command exited with code 1"),
	},
	grep: { args: { pattern: "TODO", path: "src" }, success: text("src/a.ts:1: TODO\nsrc/b.ts:9: TODO"), failure: text("rg: bad regex") },
	find: { args: { pattern: "*.ts", path: "src" }, success: text("src/a.ts\nsrc/b.ts"), failure: text("fd: invalid pattern") },
	ls: { args: { path: "src" }, success: text("a.ts\nb.ts\ndeep/"), failure: text("Path not found: src") },
};

export const CUSTOM_CASES: Record<string, Case & { author?: object }> = {
	web_search: {
		args: { query: "pi tui", limit: 3 },
		partial: text("searching"),
		success: text(lines(6, "result")),
		failure: text("Search provider unavailable"),
	},
	"fetch@author": {
		args: { urls: ["https://a.example"], options: { timeout: 5 } },
		success: text("# Fetched\nbody line"),
		failure: text("fetch failed: 503"),
		author: {
			renderResult: (result: ReturnType<typeof text>, options: { expanded: boolean }) => ({
				render: () => [`AUTHOR ${options.expanded ? "full" : "short"}: ${result.content[0]?.text.split("\n")[0] ?? ""}`],
				invalidate() {},
			}),
		},
	},
};

export const MODE_CONFIGS: Record<string, object> = {
	compact: { style: "compact" },
	preview: {
		style: "compact",
		auto_compact: { read: false, write: false, edit: false, bash: false, powershell: false, grep: false, find: false, ls: false },
		custom_tools: { auto_compact: false },
	},
	claude: { style: "claude" },
};

/** Advance the animation clock one frame at a time, drawing the rows after each. */
export function animate(rows: Component[], frames: number, width: number, draw: (frame: string[]) => void): void {
	for (let frame = 0; frame < frames; frame++) {
		mock.timers.tick(INDICATOR_INTERVAL_MS);
		draw(rows.flatMap((row) => row.render(width)));
	}
}

/**
 * One row from its first streamed argument to its end, in Pi's order: the row is
 * made as the call streams, its arguments complete, it runs and streams output,
 * extensions hear it end, and the row takes its result.
 */
export function lifecycle(
	harness: Harness,
	name: string,
	id: string,
	definition: object | undefined,
	outcome: Case,
	failed: boolean,
	expanded: boolean,
	width: number,
): string[][] {
	const frames: string[][] = [];
	const snap = (row: Component) => frames.push(row.render(width));
	const row = makeRow(name, id, {}, definition);
	row.setExpanded(expanded);
	snap(row);
	row.updateArgs(outcome.args);
	snap(row);
	animate([row], 3, width, (frame) => frames.push(frame));
	row.setArgsComplete();
	advance(250);
	harness.handlers.get("tool_execution_start")?.({ toolCallId: id, toolName: name, args: outcome.args });
	row.markExecutionStarted();
	snap(row);
	animate([row], PULSE_FRAMES, width, (frame) => frames.push(frame));
	row.updateResult({ ...(outcome.partial ?? { content: [] }), isError: false } as never, true);
	snap(row);
	animate([row], 2, width, (frame) => frames.push(frame));
	advance(1_234);
	harness.handlers.get("tool_execution_end")?.({ toolCallId: id, toolName: name, isError: failed });
	row.updateResult({ ...(failed ? outcome.failure : outcome.success), isError: failed } as never, false);
	snap(row);
	// A finished row no longer animates: further frames draw it exactly the same.
	animate([row], 2, width, (frame) => frames.push(frame));
	row.setExpanded(!expanded);
	snap(row);
	return frames;
}

