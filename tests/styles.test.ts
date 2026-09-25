/**
 * Display styles end to end: what `off`, `compact`, and `claude` install, how a
 * switch between them lands, and the guarantees the claude style's grouping keeps.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as piModule from "@earendil-works/pi-coding-agent";
import { initTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/compact-tools-config.ts";
import { groupChildren, ToolGroupController, type ToolRowLike } from "../extensions/compact-tools-grouping.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import { SUPPORTED_TOOLS } from "../extensions/compact-tools-types.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "compact-tools-styles-"));
// Syntax highlighting follows the terminal's color support; pin it so every
// machine, a CI runner without a TTY included, draws the same colors.
process.env.COLORTERM = "truecolor";
initTheme("dark", false);

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	getFgAnsi: () => "\x1b[38;2;120;120;120m",
	getColorMode: () => "truecolor",
} as unknown as Theme;

type Registered = { name: string; renderCall?: Function; renderResult?: Function };

/** Pi's own definition of a built-in tool, as it would register it. */
function piDefinition(name: string): Registered {
	const factory = `create${name === "ls" ? "Ls" : name === "powershell" ? "PowerShell" : name[0]!.toUpperCase() + name.slice(1)}ToolDefinition`;
	return (piModule as unknown as Record<string, (cwd: string) => Registered>)[factory]!("/project");
}

function writeConfig(config: object): void {
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "compact-tools.json"), JSON.stringify({ tools: SUPPORTED_TOOLS, ...config }));
}

async function startExtension() {
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const registered: Registered[] = [];
	const handlers = new Map<string, (event: any, ctx?: any) => void>();
	compactTools({
		on: (name: string, handler: (event: any, ctx?: any) => void) => handlers.set(name, handler),
		registerTool: (definition: Registered) => registered.push(definition),
		registerMarkdownTransformer: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
	} as unknown as ExtensionAPI);
	const start = (ctx: object = { cwd: "/project", mode: "print", isProjectTrusted: () => false }) =>
		handlers.get("session_start")!({ reason: "startup" }, ctx);
	return { registered, handlers, start };
}

const resolveCustomRow = (toolName: string) =>
	((globalThis as Record<symbol, unknown>)[Symbol.for("pi-compact-tools.custom.resolver")] as
		(row: { toolName: string }) => unknown)({ toolName });

test("off leaves every built-in and custom tool with Pi's own renderer", async () => {
	writeConfig({ style: "off" });
	const { registered, start } = await startExtension();
	start();
	assert.deepEqual(registered, [], "nothing is registered over Pi's tools");
	assert.equal(resolveCustomRow("web_search"), undefined, "custom rows keep their own renderer");
});

test("switching styles re-registers built-ins, and off hands them back to Pi", async () => {
	writeConfig({ style: "compact" });
	const { registered, start } = await startExtension();
	// Loading registers for the process's directory; the session's own directory registers anew.
	registered.length = 0;
	start();
	assert.deepEqual(registered.map(({ name }) => name), [...SUPPORTED_TOOLS]);
	const isPis = ({ name, renderCall }: Registered) => String(renderCall) === String(piDefinition(name).renderCall);
	assert.ok(!registered.some(isPis), "compact renderers replace Pi's");
	assert.ok(resolveCustomRow("web_search"), "custom rows are compact too");

	registered.length = 0;
	writeConfig({ style: "off" });
	start();
	assert.deepEqual(registered.map(({ name }) => name), [...SUPPORTED_TOOLS], "each tool is registered once more");
	assert.ok(registered.every(isPis), "with Pi's definitions, not this extension's");

	registered.length = 0;
	writeConfig({ style: "claude" });
	start();
	assert.deepEqual(registered.map(({ name }) => name), [...SUPPORTED_TOOLS]);
	assert.ok(!registered.some(isPis));
});

test("off binds nothing to the TUI", async () => {
	writeConfig({ style: "off" });
	const { start } = await startExtension();
	const touched: string[] = [];
	const ui = new Proxy({}, { get: (_target, key) => () => { touched.push(String(key)); } });
	start({ cwd: "/project", mode: "tui", isProjectTrusted: () => false, ui });
	// Disposing controllers that were never bound may clear what they would have set;
	// nothing may be installed.
	assert.deepEqual(touched.filter((key) => key !== "setWidget" && key !== "setStatus"), []);
});

test("the claude style reuses an unchanged result instead of laying it out again", async () => {
	writeConfig({ style: "claude" });
	const { registered, start } = await startExtension();
	start();
	const bash = registered.find(({ name }) => name === "bash")!;
	const content = [{ type: "text", text: Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n") }];
	const ctx = {
		args: { command: "seq 5000" }, argsComplete: true, cwd: "/project", executionStarted: true, expanded: false,
		invalidate() {}, isError: false, isPartial: false, lastComponent: undefined, showImages: false, state: {}, toolCallId: "reuse",
	};
	bash.renderCall!(ctx.args, plainTheme, ctx);
	const first = bash.renderResult!({ content }, { expanded: false, isPartial: false }, plainTheme, ctx) as Component;
	const lines = first.render(80).map(stripTerminalSequences);
	assert.deepEqual(lines.slice(0, 3), [" └ line 0", "   line 1", "   line 2"]);
	assert.equal(lines[3], "   … +4997 lines (ctrl+o to expand)");
	const again = bash.renderResult!({ content }, { expanded: false, isPartial: false }, plainTheme, { ...ctx, lastComponent: first });
	assert.equal(again, first);
	const changed = bash.renderResult!({ content: [...content] }, { expanded: false, isPartial: false }, plainTheme, { ...ctx, lastComponent: first });
	assert.notEqual(changed, first, "new content is drawn anew");
});

class ToolExecutionComponent {
	expanded = false;
	isPartial = false;
	result = { content: [{ type: "text" as const, text: "a" }] };
	constructor(readonly toolName: string, public args: Record<string, unknown>, readonly toolCallId = toolName) {}
	render(): string[] {
		return ["", `ROW ${this.toolName}`];
	}
	invalidate(): void {}
}

function boundGroups(style: "claude" | "compact" = "claude") {
	const runtime = new ToolRuntime();
	runtime.configure({ ...DEFAULT_CONFIG, style });
	const controller = new ToolGroupController(runtime);
	const chat = new Container();
	let factory: ((tui: unknown) => Component) | undefined;
	controller.bind({
		ui: { theme: plainTheme, setWidget: (_key: string, value: unknown) => { factory = value as typeof factory; } },
	} as unknown as ExtensionContext);
	factory!({ children: [{ children: [chat] }], requestRender() {} });
	return { controller, chat };
}

test("groups only form in the claude style, and never while silent mode hides the rows", () => {
	const rows = [new ToolExecutionComponent("read", { path: "a" }), new ToolExecutionComponent("grep", { pattern: "x" })];
	const claude = boundGroups("claude");
	claude.chat.children = rows as unknown as Component[];
	assert.match(claude.chat.render(80).join("\n"), /Searched for 1 pattern, read 1 file/u);

	const silentKey = Symbol.for("pi-compact-tools.silent.state");
	const holder = globalThis as Record<symbol, unknown>;
	const previous = holder[silentKey];
	holder[silentKey] = { active: true, enabled: true, overridden: false };
	try {
		assert.deepEqual(claude.chat.render(80), ["", "ROW read", "", "ROW grep"], "silent mode decides what shows");
	} finally {
		holder[silentKey] = previous;
	}
	claude.controller.dispose();

	const compact = boundGroups("compact");
	compact.chat.children = rows as unknown as Component[];
	assert.deepEqual(compact.chat.render(80), ["", "ROW read", "", "ROW grep"]);
	compact.controller.dispose();
});

test("a group's classification follows arguments as they stream in", () => {
	const row = new ToolExecutionComponent("bash", {});
	const make = (rows: ToolRowLike[]) => ({ render: () => [`GROUP ${rows.length}`], invalidate() {} });
	assert.deepEqual(groupChildren([row], make), [row], "an empty command looks at nothing yet");
	row.args = { command: "rg TODO src" };
	assert.deepEqual((groupChildren([row], make)[0] as Component).render(80), ["GROUP 1"], "once it arrives it folds in");
	row.args = { command: "rg TODO src && npm test" };
	assert.deepEqual(groupChildren([row], make), [row], "and a command that runs something leaves again");
});

test("an opened group closes again on click and restores the chat's own children", () => {
	const { controller, chat } = boundGroups();
	const rows = [new ToolExecutionComponent("read", { path: "a" }), new ToolExecutionComponent("read", { path: "b" })];
	chat.children = rows as unknown as Component[];
	const closed = chat.render(80);
	assert.equal(closed.length, 2);
	assert.equal(chat.children.length, 2, "the chat keeps its own children after a render");
	const click = (y: number) => chat.handleMouse({ type: "click", button: "left", x: 3, y, width: 80, height: 10 } as never);
	assert.ok(click(1));
	assert.equal(chat.render(80).length, 6, "opened: the summary and both rows");
	assert.ok(click(1));
	assert.deepEqual(chat.render(80), closed);
	controller.dispose();
});
