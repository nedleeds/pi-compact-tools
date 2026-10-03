import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configPath, registerCompactToolsCommand, saveStyle } from "../extensions/compact-tools-command.ts";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/compact-tools-config.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
function harness() {
	const root = mkdtempSync(join(tmpdir(), "compact-command-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	let command!: Command;
	registerCompactToolsCommand({ registerCommand: (name: string, definition: Command) => {
		assert.equal(name, "compact-tools");
		command = definition;
	} } as ExtensionAPI, () => DEFAULT_CONFIG);
	const notices: Array<{ message: string; type: string | undefined }> = [];
	const selections: Array<string | undefined> = [];
	const state = { idle: true, trusted: true, reloads: 0, dialogs: 0 };
	const ctx = {
		cwd: join(root, "project"), mode: "tui",
		isIdle: () => state.idle,
		isProjectTrusted: () => state.trusted,
		reload: async () => { state.reloads++; },
		ui: {
			notify: (message: string, type?: string) => { notices.push({ message, type }); },
			select: async () => { state.dialogs++; return selections.shift(); },
		},
	} as unknown as ExtensionCommandContext;
	return { command, ctx, state, notices, selections, run: (args: string) => command.handler(args, ctx), cleanup: () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	} };
}

test("style saves preserve unrelated settings, permissions and leave no temporary file", () => {
	const h = harness();
	try {
		const path = configPath(h.ctx.cwd, "global");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify({ mode: "silent", previewLines: 4, custom_tools: { exclude: ["special"] }, future: true }), { mode: 0o640 });
		saveStyle(path, "claude");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mode: "silent", previewLines: 4, custom_tools: { exclude: ["special"] }, future: true, style: "claude" });
		assert.equal(statSync(path).mode & 0o777, 0o640);
		assert.deepEqual(readdirSync(join(path, "..")), ["compact-tools.json"]);
	} finally { h.cleanup(); }
});

for (const invalid of ["{broken", "[]", "null", '"text"']) {
	test(`refuses to overwrite invalid config: ${invalid}`, async () => {
		const h = harness();
		try {
			const path = configPath(h.ctx.cwd, "global");
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, invalid);
			await h.run("claude");
			assert.equal(readFileSync(path, "utf8"), invalid);
			assert.equal(h.state.reloads, 0);
			assert.equal(h.notices.at(-1)?.type, "error");
		} finally { h.cleanup(); }
	});
}

for (const style of ["compact", "claude", "codex", "off"]) {
	test(`direct ${style} command saves globally and reloads once`, async () => {
		const h = harness();
		try {
			await h.run(style);
			assert.equal(loadConfig().style, style);
			assert.equal(h.state.reloads, 1);
			assert.equal(h.state.dialogs, 0);
			assert.doesNotMatch(h.notices.at(-1)!.message, /overrides it/);
		} finally { h.cleanup(); }
	});
}

test("without a scope, a style is saved where it is decided, so the switch always takes effect", async () => {
	const h = harness();
	try {
		const project = configPath(h.ctx.cwd, "project");
		mkdirSync(join(project, ".."), { recursive: true });
		writeFileSync(project, JSON.stringify({ style: "codex", tools: ["read", "find"] }));
		await h.run("claude");
		assert.deepEqual(JSON.parse(readFileSync(project, "utf8")), { style: "claude", tools: ["read", "find"] }, "the project that sets the style is updated");
		assert.equal(loadConfig(h.ctx.cwd, true).style, "claude", "and the switch takes effect");
		assert.equal(existsSync(configPath(h.ctx.cwd, "global")), false, "the global settings are left alone");
		assert.doesNotMatch(h.notices.at(-1)!.message, /overrides it/);
		await h.run("compact");
		assert.equal(loadConfig(h.ctx.cwd, true).style, "compact");
		// An untrusted project's settings are ignored, so the style is saved globally.
		h.state.trusted = false;
		await h.run("codex");
		assert.equal(loadConfig(h.ctx.cwd, false).style, "codex");
		assert.equal(JSON.parse(readFileSync(project, "utf8")).style, "compact");
		// A trusted project whose settings leave the style alone defers to the global one.
		h.state.trusted = true;
		writeFileSync(project, JSON.stringify({ tools: ["read"] }));
		await h.run("claude");
		assert.equal(loadConfig().style, "claude");
		assert.equal(JSON.parse(readFileSync(project, "utf8")).style, undefined);
	} finally { h.cleanup(); }
});

test("trusted project save overrides global without altering it", async () => {
	const h = harness();
	try {
		await h.run("claude");
		await h.run("off project");
		assert.equal(loadConfig().style, "claude");
		assert.equal(loadConfig(h.ctx.cwd, true).style, "off");
		assert.equal(loadConfig(h.ctx.cwd, false).style, "claude");
		const reloads = h.state.reloads;
		await h.run("compact global");
		assert.equal(loadConfig().style, "compact");
		assert.equal(loadConfig(h.ctx.cwd, true).style, "off");
		// Nothing switches here, so the notice says why and how, never that it switched, and Pi is not reloaded.
		assert.equal(h.notices.at(-1)!.message,
			"Saved compact to global settings, but this project keeps its own off style. Run /compact-tools compact to switch it here.");
		assert.equal(h.notices.at(-1)?.type, "warning");
		assert.equal(h.state.reloads, reloads, "no reload when nothing on screen changes");
	} finally { h.cleanup(); }
});

test("notices are one short line without paths, which Pi keeps in the chat", async () => {
	const h = harness();
	try {
		await h.run("codex");
		assert.equal(h.notices.at(-1)!.message, "Switching to codex style (saved to global settings). Reloading…");
		await h.run("claude project");
		assert.equal(h.notices.at(-1)!.message, "Switching to claude style (saved to this project). Reloading…");
		for (const { message } of h.notices) assert.doesNotMatch(message, /\//u, `no path: ${message}`);
	} finally { h.cleanup(); }
});

test("the chooser offers the project first when its settings choose the style", async () => {
	const h = harness();
	try {
		const project = configPath(h.ctx.cwd, "project");
		mkdirSync(join(project, ".."), { recursive: true });
		writeFileSync(project, JSON.stringify({ style: "codex" }));
		let scopes: string[] = [];
		const select = h.ctx.ui.select;
		h.ctx.ui.select = async (title, options) => {
			if (title.startsWith("Save style")) scopes = options;
			return select(title, options);
		};
		h.selections.push("Claude — group reads and searches", "Project — this trusted project only");
		await h.run("");
		assert.deepEqual(scopes, ["Project — this trusted project only", "Global — all projects (this project keeps its own style)"]);
		assert.equal(JSON.parse(readFileSync(project, "utf8")).style, "claude");
	} finally { h.cleanup(); }
});

test("untrusted project save is rejected without writes or reload", async () => {
	const h = harness();
	try {
		h.state.trusted = false;
		await h.run("claude project");
		assert.equal(existsSync(configPath(h.ctx.cwd, "project")), false);
		assert.equal(h.state.reloads, 0);
		assert.equal(h.notices.at(-1)?.type, "warning");
	} finally { h.cleanup(); }
});

test("busy agent and invalid arguments never save or reload", async () => {
	const h = harness();
	try {
		for (const args of ["unknown", "claude nowhere", "claude global extra", "help project"]) await h.run(args);
		h.state.idle = false;
		await h.run("claude");
		assert.equal(existsSync(configPath(h.ctx.cwd, "global")), false);
		assert.equal(h.state.reloads, 0);
		assert.match(h.notices.at(-1)!.message, /Wait/);
	} finally { h.cleanup(); }
});

test("the chooser offers Codex, and choosing it saves the codex style", async () => {
	const h = harness();
	try {
		let offered: string[] = [];
		const select = h.ctx.ui.select;
		h.ctx.ui.select = async (title, options) => {
			if (title.startsWith("Tool style")) offered = options;
			return select(title, options);
		};
		h.selections.push("Codex — explored groups and output tails, like Codex CLI", "Global — all projects");
		await h.run("");
		assert.deepEqual(offered.map((option) => option.split(" — ")[0]), ["Compact", "Claude", "Codex", "Off"]);
		assert.equal(loadConfig().style, "codex");
		assert.equal(h.state.reloads, 1);
	} finally { h.cleanup(); }
});

test("interactive chooser saves selected style and scope; escape cancels", async () => {
	const h = harness();
	try {
		h.selections.push(undefined, "Claude — group reads and searches", undefined);
		await h.run("");
		await h.run("");
		assert.equal(h.state.reloads, 0);
		h.selections.push("Claude — group reads and searches", "Project — this trusted project only");
		await h.run("");
		assert.equal(loadConfig(h.ctx.cwd, true).style, "claude");
		assert.equal(existsSync(configPath(h.ctx.cwd, "global")), false);
		assert.equal(h.state.reloads, 1);
	} finally { h.cleanup(); }
});

test("status and help are read-only, including while busy", async () => {
	const h = harness();
	try {
		h.state.idle = false;
		h.state.trusted = false;
		await h.run("status");
		assert.match(h.notices.at(-1)!.message, /Style: compact/);
		assert.match(h.notices.at(-1)!.message, /untrusted; ignored/);
		assert.match(h.notices.at(-1)!.message, /configured mode/);
		await h.run("help");
		assert.match(h.notices.at(-1)!.message, /Ctrl\+O/);
		assert.equal(h.state.reloads, 0);
		assert.equal(h.state.dialogs, 0);
	} finally { h.cleanup(); }
});

test("non-TUI invocation without args offers help, never a custom dialog", async () => {
	const h = harness();
	try {
		Object.assign(h.ctx, { mode: "rpc" });
		await h.run("");
		assert.equal(h.state.dialogs, 0);
		assert.equal(h.state.reloads, 0);
		assert.match(h.notices.at(-1)!.message, /Usage/);
	} finally { h.cleanup(); }
});

test("agent becoming busy during chooser cannot save", async () => {
	const h = harness();
	try {
		h.ctx.ui.select = async (_title, options) => { h.state.idle = false; return options[0]; };
		await h.run("");
		assert.equal(h.state.reloads, 0);
		assert.equal(existsSync(configPath(h.ctx.cwd, "global")), false);
	} finally { h.cleanup(); }
});

test("reload failure reports that style is already saved", async () => {
	const h = harness();
	try {
		h.ctx.reload = async () => { throw new Error("unavailable"); };
		await h.run("claude");
		assert.equal(loadConfig().style, "claude");
		assert.match(h.notices.at(-1)!.message, /Style was saved, but reload failed/);
	} finally { h.cleanup(); }
});

test("symlink-managed config updates target without replacing link", async () => {
	const h = harness();
	try {
		const path = configPath(h.ctx.cwd, "global");
		const target = join(h.ctx.cwd, "dotfiles.json");
		mkdirSync(h.ctx.cwd, { recursive: true });
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(target, JSON.stringify({ previewLines: 5 }), { mode: 0o640 });
		symlinkSync(target, path);
		await h.run("claude");
		assert.equal(lstatSync(path).isSymbolicLink(), true);
		assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { previewLines: 5, style: "claude" });
		assert.equal(statSync(target).mode & 0o777, 0o640);
		assert.equal(h.state.reloads, 1);
	} finally { h.cleanup(); }
});

test("dangling symlink is never disconnected", async () => {
	const h = harness();
	try {
		const path = configPath(h.ctx.cwd, "global");
		mkdirSync(join(path, ".."), { recursive: true });
		symlinkSync(join(h.ctx.cwd, "missing.json"), path);
		await h.run("claude");
		assert.equal(lstatSync(path).isSymbolicLink(), true);
		assert.equal(h.state.reloads, 0);
		assert.equal(h.notices.at(-1)?.type, "error");
	} finally { h.cleanup(); }
});

test("chooser does not offer project storage to untrusted projects", async () => {
	const h = harness();
	try {
		h.state.trusted = false;
		h.ctx.ui.select = async (title, options) => {
			if (title === "Save style where?") assert.deepEqual(options, ["Global — all projects"]);
			return options[0];
		};
		await h.run("");
		assert.equal(h.state.reloads, 1);
		assert.equal(existsSync(configPath(h.ctx.cwd, "project")), false);
	} finally { h.cleanup(); }
});

test("a restrictive umask does not narrow the saved file's permissions", () => {
	const h = harness();
	const previous = process.umask(0o077);
	try {
		const path = configPath(h.ctx.cwd, "global");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "{}");
		chmodSync(path, 0o644);
		saveStyle(path, "claude");
		assert.equal(statSync(path).mode & 0o777, 0o644);
	} finally {
		process.umask(previous);
		h.cleanup();
	}
});

test("a symlink to a long file name can still be saved", async () => {
	const h = harness();
	try {
		const path = configPath(h.ctx.cwd, "global");
		const target = join(h.ctx.cwd, `${"x".repeat(240)}.json`);
		mkdirSync(h.ctx.cwd, { recursive: true });
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(target, "{}");
		symlinkSync(target, path);
		await h.run("claude");
		assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { style: "claude" });
		assert.deepEqual(readdirSync(h.ctx.cwd), [`${"x".repeat(240)}.json`], "no temporary file left behind");
	} finally { h.cleanup(); }
});

test("a reload that fails after invalidating the ctx still reports the saved style", async () => {
	const h = harness();
	try {
		const ui = h.ctx.ui;
		let stale = false;
		Object.defineProperty(h.ctx, "ui", { get: () => {
			if (stale) throw new Error("This extension ctx is stale");
			return ui;
		} });
		h.ctx.reload = async () => { stale = true; throw new Error("unavailable"); };
		await h.run("claude");
		assert.equal(loadConfig().style, "claude");
		assert.match(h.notices.at(-1)!.message, /Style was saved, but reload failed: unavailable/);
	} finally { h.cleanup(); }
});

test("completion covers styles, help and explicit scope", async () => {
	const h = harness();
	try {
		assert.deepEqual(await h.command.getArgumentCompletions!("cl"), [{ value: "claude", label: "claude" }]);
		assert.deepEqual(await h.command.getArgumentCompletions!("claude p"), [{ value: "claude project", label: "claude project" }]);
		assert.deepEqual(await h.command.getArgumentCompletions!("CL"), [{ value: "claude", label: "claude" }]);
		assert.deepEqual(await h.command.getArgumentCompletions!("co"), [
			{ value: "compact", label: "compact" }, { value: "codex", label: "codex" },
		]);
		assert.deepEqual(await h.command.getArgumentCompletions!("codex g"), [{ value: "codex global", label: "codex global" }]);
		assert.equal(await h.command.getArgumentCompletions!("unknown"), null);
		// Pi applies a shown completion on Enter, so a command typed in full offers none and runs on the first Enter.
		for (const typed of ["codex", "codex project", "claude global", "status"]) {
			assert.equal(await h.command.getArgumentCompletions!(typed), null, typed);
		}
		assert.deepEqual(await h.command.getArgumentCompletions!("codex "), [
			{ value: "codex global", label: "codex global" }, { value: "codex project", label: "codex project" },
		]);
	} finally { h.cleanup(); }
});
