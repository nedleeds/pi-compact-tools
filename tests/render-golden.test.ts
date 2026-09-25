/**
 * Golden renders: every tool, in every display mode, collapsed and opened, running,
 * finished, and failed, at a wide and a narrow width. The first run records what
 * each row draws; every later run must draw exactly the same. Rerun with
 * UPDATE_GOLDEN=1 only when a change to the output is intended.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { generateDiffString, generateUnifiedPatch } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js";
import { DEFAULT_CONFIG } from "../extensions/compact-tools-config.ts";
import { ToolGroupController } from "../extensions/compact-tools-grouping.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";

const GOLDEN_PATH = join(import.meta.dirname, "golden", "render.json");
const WIDTHS = [100, 44];

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "compact-tools-golden-"));
initTheme("dark", false);

// A theme whose colors are real, zero-width escape sequences, so wrapping and
// truncation measure what a terminal would. Each color gets its own RGB value,
// which the recorder turns back into a readable name.
const COLOR_NAMES = [
	"text", "muted", "dim", "accent", "toolOutput", "toolTitle", "error", "success", "warning", "borderMuted",
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "thinkingText", "border", "customMessageLabel",
];
const rgbOf = (name: string): string => {
	const index = COLOR_NAMES.indexOf(name);
	const seed = index >= 0 ? index * 37 + 20 : [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0);
	return `${(seed * 7) % 256};${(seed * 13 + 50) % 256};${(seed * 29 + 90) % 256}`;
};
const colorByRgb = new Map(COLOR_NAMES.map((name) => [rgbOf(name), name]));
const theme = {
	fg: (color: string, text: string) => `\x1b[38;2;${rgbOf(color)}m${text}\x1b[39m`,
	bg: (color: string, text: string) => `\x1b[48;2;${rgbOf(color)}m${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	getFgAnsi: (color: string) => `\x1b[38;2;${rgbOf(color)}m`,
	getColorMode: () => "truecolor",
} as unknown as Theme;

/** Escape sequences as short readable marks; a color the theme names reads as `{name}`. */
function readable(line: string): string {
	return line
		.replace(/\x1b\[38;2;(\d+;\d+;\d+)m/gu, (_, rgb: string) => `{${colorByRgb.get(rgb) ?? rgb}}`)
		.replace(/\x1b\[48;2;(\d+;\d+;\d+)m/gu, (_, rgb: string) => `{bg:${colorByRgb.get(rgb) ?? rgb}}`)
		.replace(/\x1b\[39m/gu, "{/}")
		.replace(/\x1b\[49m/gu, "{/bg}")
		.replace(/\x1b\[1m/gu, "{b}")
		.replace(/\x1b\[22m/gu, "{/b}")
		.replace(/\x1b\[3m/gu, "{i}")
		.replace(/\x1b\[23m/gu, "{/i}")
		.replace(/\x1b\[0m/gu, "{0}")
		.replace(/\x1b/gu, "\\e");
}

// Time stands still unless a scenario moves it, so durations are exact.
let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;

type Definition = {
	name: string;
	renderCall: (args: any, theme: Theme, ctx: any) => Component;
	renderResult: (result: any, options: any, theme: Theme, ctx: any) => Component;
};
type Result = { content: Array<{ type: "text"; text: string }>; details?: unknown };

const text = (value: string, details?: unknown): Result => ({ content: [{ type: "text", text: value }], details });
const lines = (count: number, label = "line") => Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n");

const oldFile = `${lines(30)}\n`;
const newFile = oldFile.replace("line 5\n", "changed 5\n").replace("line 20\n", "changed 20\nadded 20b\n");
const bigOld = `${lines(20, "old")}\n`;
const bigNew = `${lines(20, "new")}\n`;

type Case = { args: Record<string, unknown>; success: Result; failure: Result; partial?: Result };

/** One realistic call and outcome per tool, and the variations that take other paths. */
const CASES: Record<string, Case> = {
	read: {
		args: { path: "src/app.ts" },
		success: text(`${lines(25)}\n\n[Showing lines 1-25 of 80. Use offset=26 to continue.]`),
		failure: text("ENOENT: no such file or directory, access 'src/app.ts'"),
	},
	"read@offset": {
		args: { path: "src/app.ts", offset: 40, limit: 3 },
		success: text("const a = 1;\nconst b = 2;\nexport { a, b };"),
		failure: text("Offset 40 is beyond end of file (12 lines total)"),
	},
	write: {
		args: { path: "notes.md", content: lines(15) },
		success: text("Successfully wrote 97 bytes to notes.md"),
		failure: text("EACCES: permission denied, open 'notes.md'"),
	},
	edit: {
		args: { path: "app.ts", edits: [{ oldText: "line 5", newText: "changed 5" }] },
		success: text("Successfully replaced 2 block(s) in app.ts.", {
			diff: generateDiffString(oldFile, newFile).diff,
			patch: generateUnifiedPatch("app.ts", oldFile, newFile),
		}),
		failure: text("Could not find the exact text in app.ts. The old text must match exactly including all whitespace and newlines."),
	},
	"edit@large": {
		args: { path: "big.txt", edits: [{ oldText: "old", newText: "new" }] },
		success: text("Successfully replaced 1 block(s) in big.txt.", {
			diff: generateDiffString(bigOld, bigNew).diff,
			patch: generateUnifiedPatch("big.txt", bigOld, bigNew),
		}),
		failure: text("Found 20 occurrences of the text in big.txt. The text must be unique."),
	},
	bash: {
		args: { command: "npm test" },
		success: text(`> test\n> node --test\n${lines(24, "ok")}`),
		failure: text("npm ERR! missing script: test\nnpm ERR! A complete log is in ~/.npm/_logs\n\nCommand exited with code 1"),
		partial: text("> test\n> node --test\nok 1"),
	},
	"bash@quiet": {
		args: { command: "true" },
		success: text("(no output)"),
		failure: text("Command timed out after 5 seconds"),
	},
	"bash@wide": {
		args: { command: "cat package.json | jq '.scripts' && echo 'a very long command that keeps going well past the edge of a narrow terminal'" },
		success: text(`${"x".repeat(150)}\n      70 /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md\nlast`),
		failure: text("jq: error (at <stdin>:1): Cannot index string with \"scripts\"\nCommand exited with code 5"),
	},
	"bash@four": {
		args: { command: "seq 1 4" },
		success: text("1\n2\n3\n4"),
		failure: text("seq: invalid argument\nCommand exited with code 1"),
	},
	powershell: {
		args: { command: "Get-ChildItem -Path src | Select-Object Name" },
		success: text("Name\n----\napp.ts\nutil.ts"),
		failure: text("Get-ChildItem: Cannot find path 'src'\nCommand exited with code 1"),
	},
	grep: {
		args: { pattern: "TODO", path: "src" },
		success: text("app.ts:2: // TODO: rename\nutil.ts:9: // TODO: split"),
		failure: text("rg: src: No such file or directory"),
	},
	find: {
		args: { pattern: "*.ts", path: "src" },
		success: text("src/app.ts\nsrc/util.ts\nsrc/deep/x.ts"),
		failure: text("fd: invalid pattern"),
	},
	ls: {
		args: { path: "src" },
		success: text("app.ts\nutil.ts\ndeep/"),
		failure: text("Path not found: src"),
	},
};

type Phase = "running" | "done" | "failed";
const PHASES: Phase[] = ["running", "done", "failed"];

let callSequence = 0;

/**
 * Draw one row the way Pi does: the call as its arguments stream and run, then
 * the call and result together once it has finished.
 */
function renderRow(
	definition: Definition,
	args: Record<string, unknown>,
	phase: Phase,
	expanded: boolean,
	outcome: Case,
	width: number,
	events?: Map<string, (event: any) => void>,
): string[] {
	const toolCallId = `call-${++callSequence}`;
	const state = {};
	const context = (isError: boolean, isPartial: boolean) => ({
		args,
		argsComplete: true,
		cwd: "/project",
		executionStarted: true,
		expanded,
		invalidate: () => {},
		isError,
		isPartial,
		lastComponent: undefined,
		showImages: false,
		state,
		toolCallId,
	});
	events?.get("tool_execution_start")?.({ toolCallId });
	definition.renderCall(args, theme, context(false, true)).render(width);
	now += 1_234;
	if (phase === "running") {
		const partial = outcome.partial ?? { content: [] };
		const running = context(false, true);
		return [
			...definition.renderCall(args, theme, running).render(width),
			...definition.renderResult(partial, { expanded, isPartial: true }, theme, running).render(width),
		];
	}
	events?.get("tool_execution_end")?.({ toolCallId });
	const failed = phase === "failed";
	const finished = context(failed, false);
	const result = failed ? outcome.failure : outcome.success;
	return [
		...definition.renderCall(args, theme, finished).render(width),
		...definition.renderResult(result, { expanded, isPartial: false }, theme, finished).render(width),
	];
}

function loadGolden(): Record<string, string[]> {
	return existsSync(GOLDEN_PATH) ? JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) : {};
}

const recorded: Record<string, string[]> = {};
const golden = loadGolden();
const updating = process.env.UPDATE_GOLDEN === "1";

function check(key: string, output: string[]): void {
	const value = output.map(readable);
	recorded[key] = value;
	if (updating) return;
	assert.ok(key in golden, `no golden render for ${key}; rerun with UPDATE_GOLDEN=1 to record it`);
	assert.deepEqual(value, golden[key], key);
}

const MODE_CONFIGS: Record<string, object> = {
	compact: { style: "compact" },
	preview: { style: "compact", auto_compact: Object.fromEntries(Object.keys(CASES).map((name) => [name.split("@")[0], false])) },
	claude: { style: "claude" },
};

async function loadExtension(config: object) {
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "compact-tools.json"), JSON.stringify({
		tools: ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"],
		...config,
	}));
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const definitions = new Map<string, Definition>();
	const handlers = new Map<string, (event: any, ctx?: any) => void>();
	compactTools({
		on: (name: string, handler: (event: any, ctx?: any) => void) => handlers.set(name, handler),
		registerTool: (definition: Definition) => definitions.set(definition.name, definition),
		registerMarkdownTransformer: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
	} as unknown as ExtensionAPI);
	handlers.get("session_start")!({ reason: "startup" }, {
		cwd: "/project",
		mode: "print",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext);
	return { definitions, handlers };
}

type RowRenderers = { renderCall: Definition["renderCall"]; renderResult: Definition["renderResult"] };

function customRow(toolName: string, author?: object): Definition {
	const resolve = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-compact-tools.custom.resolver")] as
		(row: { toolName: string; toolDefinition?: object }) => RowRenderers | undefined;
	const renderers = resolve({ toolName, toolDefinition: author });
	assert.ok(renderers, `custom row for ${toolName}`);
	return { name: toolName, ...renderers };
}

const authorRenderer = {
	renderResult: (result: Result, options: { expanded: boolean }) => ({
		render: () => [`AUTHOR ${options.expanded ? "full" : "short"}: ${result.content[0]?.text.split("\n")[0] ?? ""}`],
		invalidate() {},
	}),
};

const CUSTOM_CASES: Record<string, Case & { author?: object }> = {
	web_search: {
		args: { query: "pi tui", limit: 3 },
		success: text(lines(6, "result")),
		failure: text("Search provider unavailable\nCommand exited with code 7"),
	},
	"fetch@author": {
		args: { urls: ["https://a.example", "https://b.example"], options: { timeout: 5 } },
		success: text("# Fetched\nbody line"),
		failure: text("fetch failed: 503"),
		author: authorRenderer,
	},
};

for (const [mode, config] of Object.entries(MODE_CONFIGS)) {
	test(`golden: every built-in row in ${mode} mode`, async () => {
		const { definitions } = await loadExtension(config);
		for (const [key, outcome] of Object.entries(CASES)) {
			const definition = definitions.get(key.split("@")[0]!)!;
			for (const phase of PHASES) {
				for (const expanded of [false, true]) {
					for (const width of WIDTHS) {
						check(`${mode}/${key}/${phase}/${expanded ? "open" : "closed"}/${width}`,
							renderRow(definition, outcome.args, phase, expanded, outcome, width));
					}
				}
			}
		}
	});

	test(`golden: custom tool rows in ${mode} mode`, async () => {
		const { handlers } = await loadExtension(config);
		for (const [key, outcome] of Object.entries(CUSTOM_CASES)) {
			for (const phase of PHASES) {
				for (const expanded of [false, true]) {
					for (const width of WIDTHS) {
						// Custom rows keep their compact state in the renderer pair, one pair per row.
						const definition = customRow(key.split("@")[0]!, outcome.author);
						check(`${mode}/custom:${key}/${phase}/${expanded ? "open" : "closed"}/${width}`,
							renderRow(definition, outcome.args, phase, expanded, outcome, width, handlers));
					}
				}
			}
		}
	});
}

// Stand-ins for Pi's rows, named like its class so grouping recognizes them.
class ToolExecutionComponent {
	expanded = false;
	constructor(
		readonly toolName: string,
		readonly args: Record<string, unknown>,
		public result: (Result & { isError?: boolean }) | undefined,
		public isPartial: boolean,
		readonly toolCallId: string,
	) {}
	render(): string[] {
		return ["", `ROW ${this.toolName} ${JSON.stringify(this.args)}`];
	}
	invalidate(): void {}
}

test("golden: claude mode groups in the transcript", () => {
	const runtime = new ToolRuntime();
	runtime.configure({ ...DEFAULT_CONFIG, style: "claude" });
	const controller = new ToolGroupController(runtime);
	const chat = new Container();
	let factory: ((tui: unknown) => Component) | undefined;
	controller.bind({
		ui: { theme, setWidget: (_key: string, value: unknown) => { factory = value as typeof factory; } },
	} as unknown as ExtensionContext);
	factory!({ children: [{ children: [chat] }], requestRender() {} });
	const tool = (name: string, args: Record<string, unknown>, state: "running" | "done" | "failed", id: string) =>
		new ToolExecutionComponent(name, args, state === "running" ? undefined
			: { ...text(state === "failed" ? "ENOENT: gone" : "a\nb"), isError: state === "failed" }, state === "running", id);
	const thinking = new AssistantMessageComponent({
		content: [{ type: "thinking", thinking: "Looking around" }, { type: "toolCall", id: "t", name: "read", arguments: {} }],
		stopReason: "toolUse",
	} as never);
	const answer = new AssistantMessageComponent({ content: [{ type: "text", text: "All done." }], stopReason: "stop" } as never);
	const scenes: Record<string, unknown[]> = {
		"finished": [
			tool("read", { path: "a.ts" }, "done", "g1"), tool("read", { path: "b.ts" }, "done", "g2"),
			tool("read", { path: "a.ts" }, "done", "g3"), tool("grep", { pattern: "TODO" }, "done", "g4"),
			thinking, tool("ls", { path: "src" }, "done", "g5"), tool("bash", { command: "rg x | head" }, "done", "g6"),
			tool("bash", { command: "npm test" }, "done", "g7"), tool("find", { pattern: "*.ts" }, "done", "g8"), answer,
		],
		"running": [
			tool("read", { path: "a.ts" }, "done", "r1"), tool("bash", { command: "cat long.log | tail -5" }, "running", "r2"),
		],
		"failed": [
			tool("read", { path: "a.ts" }, "done", "f1"), tool("read", { path: "gone.ts" }, "failed", "f2"),
		],
		"streaming": [tool("grep", {}, "running", "s1")],
	};
	for (const [name, children] of Object.entries(scenes)) {
		chat.children = children as Component[];
		for (const width of WIDTHS) check(`claude/group:${name}/${width}`, chat.render(width));
		// Ctrl+O opens every row, and the groups follow.
		for (const child of children) if (child instanceof ToolExecutionComponent) child.expanded = true;
		check(`claude/group:${name}/opened/100`, chat.render(100));
		for (const child of children) if (child instanceof ToolExecutionComponent) child.expanded = false;
		chat.render(100);
	}
	controller.dispose();
});

test("golden: nothing recorded is missing and nothing extra is left behind", () => {
	if (updating) {
		writeFileSync(GOLDEN_PATH, `${JSON.stringify(recorded, null, "\t")}\n`);
		return;
	}
	assert.deepEqual(Object.keys(golden).filter((key) => !(key in recorded)), [], "golden renders no test produces any more");
});

test.after(() => {
	Date.now = realNow;
});
