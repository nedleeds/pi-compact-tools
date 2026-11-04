import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashToolDefinition, initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import compactTools from "../extensions/compact-tools.ts";
import { usesNativeChangelog } from "../extensions/compact-tools-release.ts";

type Listener = (event: any, ctx: any) => void;
for (const publicAPI of [true, false]) for (const style of ["compact", "claude", "codex"]) test(`${style}: streamed arguments and Pi 1.5 frame coalescing (public=${publicAPI})`, () => {
	const directory = mkdtempSync(join(tmpdir(), "compact-stream-host-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const handlers = new Map<string, Listener[]>();
	let resolve = (_name: string, next: () => any): any => next();
	const chat = new Container();
	const tui = { children: [{ children: [chat] }], requestRender() {} };
	const ui = new Proxy({}, { get(_target, key) {
		if (key === "theme") return theme;
		if (key === "setWidget") return (_name: string, factory: unknown) => { if (typeof factory === "function") factory(tui); };
		return () => () => {};
	} });
	const ctx = { cwd: directory, mode: "tui", isIdle: () => false, isProjectTrusted: () => false, ui };
	const emit = (name: string, event: unknown) => handlers.get(name)?.forEach(fn => fn(event, ctx));
	try {
		writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ style }));
		initTheme("dark", false);
		compactTools({
			on(name: string, handler: Listener) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerCommand() {}, registerShortcut() {}, registerMarkdownTransformer() {},
			registerToolRenderer: publicAPI ? (resolver: typeof resolve) => { resolve = resolver; } : undefined,
		} as unknown as ExtensionAPI);
		emit("session_start", { reason: "startup" }); emit("agent_start", {});
		emit("message_update", { message: { role: "assistant", content: [{ type: "toolCall", id: "stream", name: "bash" }] } });
		const base = createBashToolDefinition(directory);
		const row = new ToolExecutionComponent("bash", "stream", { command: "ls /initial" }, {}, resolve("bash", () => base), { requestRender() {} } as never, directory);
		chat.addChild(row);
		chat.render(100);
		const internal = row as unknown as { updateDisplay(): void };
		const update = internal.updateDisplay.bind(row);
		let updates = 0;
		internal.updateDisplay = () => { updates++; update(); };
		row.updateArgs({ command: "ls /middle" });
		row.updateArgs({ command: "ls /later" });
		row.updateArgs({ command: "zz-streamed-run --path" });
		if (usesNativeChangelog()) assert.equal(updates, 0, "Pi 1.5 defers partial rendering until the next frame");
		const drawn = chat.render(100).map(stripTerminalSequences).join("\n");
		assert.match(drawn, style === "compact" ? /Run zz streamed run/u : /zz-streamed-run --path/u,
			"latest command must leave the exploration group and show its own row (Compact uses a humanized title)");
		assert.doesNotMatch(drawn, /\/initial|\/middle|\/later/u);
		if (usesNativeChangelog()) assert.equal(updates, 1, "one render per frame, not per streamed delta");
	} finally {
		emit("session_shutdown", { reason: "quit" });
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
