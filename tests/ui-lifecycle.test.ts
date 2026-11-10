import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install } from "@sinonjs/fake-timers";
import { initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import compactTools from "../extensions/compact-tools.ts";
import { isSilent } from "../extensions/compact-tools-silent.ts";

function harness(publicAPI: boolean, initial = "claude", overrides: object = {}) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-ui-lifecycle-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	const configPath = join(directory, "compact-tools.json");
	const save = (style: string, extra: object = {}) => writeFileSync(configPath, JSON.stringify({ style, mode: "silent", ...overrides, ...extra }));
	save(initial); initTheme("dark", false);
	const clock = install({ toFake: ["setInterval", "clearInterval"] });
	const handlers = new Map<string, Function[]>(), commands = new Map<string, any>();
	const widgets = new Map<string, unknown>(), inputs = new Set<Function>();
	const notifications: Array<{ message: string; level: string }> = [];
	const chat = new Container();
	const tui = { children: [{ children: [chat] }], requestRender() {} };
	let resolver: Function = (_name: string, next: Function) => next();
	let working: string | undefined, indicator: unknown, probeMounts = 0;
	type CleanupFault = "working" | "thinking" | "status" | "widget" | "unsubscribe";
	let fault: CleanupFault | undefined;
	let nativeLabelRestores = 0;
	let hiddenLabel: string | undefined;
	let transform: Function = (markdown: string) => markdown;
	const failOnce = (kind: CleanupFault) => { if (fault === kind) { fault = undefined; throw Error(`host ${kind} cleanup failed`); } };
	const api = {
		theme,
		setWidget(name: string, factory: unknown) {
			if (typeof factory === "function") {
				if (name === "compact-tools-render") probeMounts++;
				widgets.set(name, factory(tui));
			} else {
				if (name === "compact-tools-silent") failOnce("widget");
				widgets.delete(name);
			}
		},
		onTerminalInput(listener: Function) { inputs.add(listener); return () => { inputs.delete(listener); failOnce("unsubscribe"); }; },
		setWorkingVisible() {},
		setWorkingMessage(message?: string) {
			if (message === undefined) failOnce("working");
			working = message;
		},
		setWorkingIndicator(value?: unknown) { indicator = value; },
		setHiddenThinkingLabel(label?: string) { if (label === undefined) { failOnce("thinking"); nativeLabelRestores++; } hiddenLabel = label; },
		setStatus() { failOnce("status"); },
		notify(message: string, level: string) { notifications.push({ message, level }); },
	};
	// Unlike permissive no-op proxies, fail a test on an unknown UI method.
	const ui = new Proxy(api, { get(target, key) {
		if (!(key in target)) throw Error(`Unexpected UI API: ${String(key)}`);
		return Reflect.get(target, key);
	} });
	const ctx = { cwd: directory, mode: "tui", isIdle: () => false, isProjectTrusted: () => false, ui, reload: async () => { throw Error("Unexpected reload"); } };
	compactTools({
		on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		registerCommand(name: string, command: unknown) { commands.set(name, command); }, registerShortcut() {}, registerMarkdownTransformer(fn: Function) { transform = fn; },
		registerToolRenderer: publicAPI ? (fn: Function) => { resolver = fn; } : undefined,
	} as unknown as ExtensionAPI);
	const emit = async (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
	const command = (style: string) => commands.get("compact-tools").handler(style, ctx);
	const author = { renderShell: "self", renderCall: () => new Text("AUTHOR CALL"), renderResult: () => new Text("AUTHOR RESULT") };
	const addRow = (id: string) => {
		const row = new ToolExecutionComponent("author_tool", id, {}, {}, resolver("author_tool", () => author), { requestRender() {} } as never, directory);
		row.markExecutionStarted();
		row.updateResult({ content: [{ type: "text", text: "partial" }], details: undefined, isError: false } as never, true);
		chat.addChild(row);
		return row;
	};
	const detached = (checkWorking = true, checkWidgets = true) => {
		assert.equal(inputs.size, 0);
		if (checkWidgets) assert.equal(widgets.size, 0);
		assert.equal(clock.countTimers(), 0); assert.equal(isSilent(), false);
		assert.equal(indicator, undefined);
		if (checkWorking) assert.equal(working, undefined);
	};
	return { save, clock, ctx, chat, author, notifications, widgets, inputs, emit, command, addRow, detached,
		get probeMounts() { return probeMounts; },
		get working() { return working; },
		get indicator() { return indicator; },
		get hiddenLabel() { return hiddenLabel; },
		thinking(markdown: string) { return transform(markdown, { messageType: "assistant-thinking", availableWidth: 80 }); },
		get nativeLabelRestores() { return nativeLabelRestores; },
		failCleanup(kind: CleanupFault) { fault = kind; },
		async close() {
			try { await emit("session_shutdown", { reason: "quit" }); }
			finally {
				clock.uninstall();
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
				rmSync(directory, { recursive: true, force: true });
			}
		},
	};
}

for (const publicAPI of [false, true]) for (const thinking of [false, true]) for (const working of [false, true]) {
	test(`independent native UI switches apply live (public=${publicAPI}, thinking=${thinking}, working=${working})`, async () => {
		const h = harness(publicAPI, "compact", { mode: "normal", thinking, working });
		const markdown = "**Plan**\n\nOriginal thinking details.";
		const check = (styledThinking: boolean, styledWorking: boolean) => {
			assert.equal(h.thinking(markdown) === markdown, !styledThinking);
			assert.equal(h.hiddenLabel !== undefined, styledThinking);
			assert.equal(h.indicator !== undefined, styledWorking);
			assert.equal(h.working !== undefined, styledWorking);
			// No thinking listener may consume the host's Ctrl+T in native mode.
			if (!styledThinking) for (const listener of h.inputs) {
				assert.notEqual(listener("\x14")?.consume, true);
			}
		};
		try {
			await h.emit("session_start", { reason: "startup" });
			await h.emit("agent_start", {});
			check(thinking, working);
			const row = h.addRow("tool-only");
			assert.doesNotMatch(row.render(80).join("\n"), /AUTHOR CALL/, "tool styling remains enabled");
			await h.command(`thinking ${thinking ? "native" : "styled"}`);
			await h.command(`working ${working ? "native" : "styled"}`);
			check(!thinking, !working);
			await h.command(`thinking ${thinking ? "styled" : "native"}`);
			await h.command(`working ${working ? "styled" : "native"}`);
			check(thinking, working);
			await h.command("off");
			check(false, false);
			await h.command("compact");
			check(thinking, working);
			await h.emit("session_start", { reason: "reload" });
			await h.emit("agent_start", {});
			check(thinking, working);
			assert.equal(h.notifications.filter(item => item.level === "warning").length, 0);
		} finally { await h.close(); }
	});
}

for (const publicAPI of [false, true]) for (const route of ["live-off", "startup-off", "replacement-off", "shutdown", "reload-off"]) {
	test(`${route} uses the same complete UI cleanup inventory (public=${publicAPI})`, async () => {
		const h = harness(publicAPI, route === "startup-off" ? "off" : "claude");
		try {
			// Provisional rows can exist before trusted session configuration arrives.
			const row = h.addRow("provisional");
			await h.emit("session_start", { reason: "startup" });
			await h.emit("agent_start", {});
			if (route === "live-off") await h.command("off");
			if (route === "replacement-off") { h.save("off"); await h.emit("session_start", { reason: "switch" }); }
			if (route === "shutdown") await h.emit("session_shutdown", { reason: "quit" });
			if (route === "reload-off") { await h.command("off"); await h.emit("session_start", { reason: "reload" }); }
			h.detached();
			if (route === "startup-off") assert.equal(h.probeMounts, 1, "one-shot startup reconciliation does not bind a persistent renderer");
			if (route !== "shutdown") {
				assert.equal((row as any).toolDefinition, h.author);
				const restores = h.nativeLabelRestores;
				await h.command("off"); h.detached();
				assert.equal(h.nativeLabelRestores, restores + 1, "off->off explicitly restores the native hidden-thinking label");
				await h.emit("message_update", { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta" } });
				await h.emit("tool_execution_start", { toolName: "author_tool", toolCallId: "off-call", args: {} });
				h.clock.tick(500);
				h.detached();
				await h.command("compact");
				assert.ok(h.inputs.size > 0); assert.ok(h.widgets.size > 0);
				await h.command("off"); h.detached();
			}
			assert.equal(h.notifications.filter(item => item.level === "warning").length, 0);
		} finally { await h.close(); }
	});
}

for (const publicAPI of [false, true]) test(`one bad row warns once but cannot skip other rows or off/on cleanup (public=${publicAPI})`, async () => {
	const h = harness(publicAPI);
	try {
		await h.emit("session_start", { reason: "startup" }); await h.emit("agent_start", {});
		const bad = h.addRow("bad"), good = h.addRow("good");
		const original = Object.getOwnPropertyDescriptor(bad, "toolDefinition")!;
		Object.defineProperty(bad, "toolDefinition", { configurable: true, get() { throw Error("bad row getter"); } });
		for (const style of ["off", "compact", "off"]) {
			const before = h.notifications.length;
			await h.command(style);
			const warnings = h.notifications.slice(before).filter(item => item.level === "warning");
			assert.equal(warnings.length, 1); assert.match(warnings[0]!.message, /tool row.*\/reload/);
			if (style === "off") { h.detached(); assert.equal((good as any).toolDefinition, h.author); }
			else { assert.ok(h.widgets.size > 0); assert.ok(h.inputs.size > 0); }
		}
		// Never claim a failed row recovered; remove the fault and explicitly retry.
		Object.defineProperty(bad, "toolDefinition", original);
		await h.command("compact"); await h.command("off");
		assert.equal((bad as any).toolDefinition, h.author); h.detached();
	} finally { await h.close(); }
});

for (const publicAPI of [false, true]) for (const fault of ["working", "thinking", "status", "widget", "unsubscribe"] as const) test(`host ${fault} cleanup failure is reported but detached observers cannot restart animations (public=${publicAPI})`, async () => {
	const h = harness(publicAPI);
	try {
		await h.emit("session_start", { reason: "startup" }); await h.emit("agent_start", {});
		h.failCleanup(fault);
		await h.command("off");
		assert.equal(h.notifications.filter(item => item.level === "warning").length, 1);
		// Host rejection may leave old text or an inert widget; don't claim it vanished.
		h.detached(fault !== "working", fault !== "widget");
		if (fault === "widget") assert.equal(h.widgets.has("compact-tools-silent"), true);
		await h.emit("message_update", { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta" } });
		h.clock.tick(1000); h.detached(fault !== "working", fault !== "widget");
		await h.command("compact"); await h.command("off"); h.detached();
	} finally { await h.close(); }
});

test("shutdown completes when both host cleanup and its warning notification fail", async (t) => {
	const h = harness(true);
	const fallback = t.mock.method(console, "warn", () => {});
	try {
		await h.emit("session_start", { reason: "startup" }); await h.emit("agent_start", {});
		h.failCleanup("working");
		h.ctx.ui.notify = () => { throw Error("stale notification UI"); };
		await h.emit("session_shutdown", { reason: "quit" });
		h.detached(false);
		assert.equal(fallback.mock.calls.length, 1);
		assert.match(String(fallback.mock.calls[0]!.arguments[0]), /progress cleanup.*\/reload/);
	} finally { await h.close(); }
});
