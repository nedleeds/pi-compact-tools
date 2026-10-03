/**
 * /compact-tools switches between the compact, Claude, and Codex styles in place: no
 * reload, so it works while a response runs. Rows already on screen, a running one
 * included, are drawn again in the new style and keep animating; silent mode hides
 * them in any style and shows them in the current one. Only off waits for the reload.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	announce, INDICATOR_INTERVAL_MS, loadExtension, makeRow, restoreClocks, shutdown, text, timerClock, type Harness,
} from "./indicator-harness.ts";

type Row = ReturnType<typeof makeRow>;
let sequence = 0;

/** A call Pi has announced and started; `output`, when given, has streamed in. */
function started(harness: Harness, name: string, args: object, output?: string): Row {
	const id = `live-${name}-${++sequence}`;
	announce(harness, id, name);
	const row = makeRow(name, id, args, harness.definitions.get(name));
	row.setArgsComplete();
	harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: name, args });
	row.markExecutionStarted();
	if (output !== undefined) row.updateResult({ ...text(output), isError: false } as never, true);
	return row;
}

function finished(harness: Harness, name: string, args: object, output: string): Row {
	const row = started(harness, name, args);
	const id = (row as unknown as { toolCallId: string }).toolCallId;
	harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
	row.updateResult({ ...text(output), isError: false } as never, false);
	return row;
}

/** What a user typing the command sees, and whether it reloaded Pi. */
function commandContext(busy: boolean) {
	const notices: Array<{ message: string; type?: string }> = [];
	let reloads = 0;
	const ctx = {
		cwd: "/project",
		mode: "tui",
		isIdle: () => !busy,
		isProjectTrusted: () => false,
		reload: async () => { reloads++; },
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }), select: async () => undefined },
	};
	return { ctx, notices, reloads: () => reloads };
}

const plain = (harness: Harness) => harness.chat.render(100).map(stripTerminalSequences).filter((line) => line.trim());

/** The first line each style draws for this transcript: a group, a custom tool, and a running command. */
const HEADS = {
	codex: [" • Explored", " • Called web_search", " • Running for i in 1 2 3; do echo tick $i; sleep 1; done"],
	claude: [" ⦁ Searched for 1 pattern, read 1 file (click to expand)", ' ⦁ web_search(query: "pi tui")', " ⦁ Bash(for i in 1 2 3; do echo tick $i; sleep 1; done)"],
	compact: [" ⦁ read src/app.ts", " ⦁ grep /TODO/ in src", " ⦁ web_search", " ⦁ bash Run for"],
} as const;

function heads(harness: Harness): string[] {
	return plain(harness).filter((line) => /^ [•⦁] /u.test(line)).map((line) => line.replace(/\s+$/u, ""));
}

async function transcript(style: "codex" | "claude" | "compact") {
	const harness = await loadExtension({ style }, { tui: true, idle: false });
	const running = started(harness, "bash", { command: "for i in 1 2 3; do echo tick $i; sleep 1; done" }, "tick 1\ntick 2");
	harness.chat.children = [
		finished(harness, "read", { path: "src/app.ts" }, "line 1\nline 2"),
		finished(harness, "grep", { pattern: "TODO", path: "src" }, "src/a.ts:1: TODO"),
		finished(harness, "web_search", { query: "pi tui" }, "result 1"),
		running,
	];
	return { harness, running };
}

const switchTo = async (harness: Harness, args: string, busy = true) => {
	const command = commandContext(busy);
	await harness.commands.get("compact-tools")!.handler(args, command.ctx);
	return command;
};

test("while a command runs, /compact-tools redraws every row in each style, with no reload", async () => {
	const { harness } = await transcript("codex");
	try {
		assert.deepEqual(heads(harness), [...HEADS.codex]);
		for (const style of ["claude", "compact", "codex", "claude"] as const) {
			const command = await switchTo(harness, style);
			assert.equal(command.reloads(), 0, `${style}: no reload`);
			assert.match(command.notices.at(-1)!.message, new RegExp(`^Switched to ${style} style`, "u"), style);
			const drawn = heads(harness);
			for (const head of HEADS[style]) assert.ok(drawn.some((line) => line.startsWith(head)), `${style}: ${head}\n${drawn.join("\n")}`);
		}
		// The running command keeps what it has streamed: Claude Code shows it as running, Codex shows its tail.
		assert.ok(plain(harness).some((line) => /⎿ {2}Running…/u.test(line)), plain(harness).join("\n"));
		await switchTo(harness, "codex");
		assert.ok(plain(harness).some((line) => /└ tick 1/u.test(line)), plain(harness).join("\n"));
	} finally { shutdown(harness); }
});

test("a running call keeps pulsing after a switch, in every style", async () => {
	const { harness } = await transcript("compact");
	try {
		for (const style of ["codex", "claude", "compact"] as const) {
			await switchTo(harness, style);
			const before = harness.requestRenders();
			const dots = new Set<string>();
			for (let frame = 0; frame < 8; frame++) {
				timerClock.tick(INDICATOR_INTERVAL_MS);
				const line = harness.chat.render(100).find((each) => /Running|Bash\(|bash Run/u.test(stripTerminalSequences(each)))!;
				dots.add(line.slice(0, line.search(/[•⦁]/u) + 1));
			}
			assert.ok(dots.size > 1, `${style}: the running dot animates`);
			assert.ok(harness.requestRenders() > before, `${style}: and asks for frames`);
		}
	} finally { shutdown(harness); }
});

test("only a switch to or from off waits for the response, and then reloads", async () => {
	const { harness } = await transcript("claude");
	try {
		const blocked = await switchTo(harness, "off");
		assert.match(blocked.notices.at(-1)!.message, /Wait for the current response/u);
		assert.equal(blocked.reloads(), 0);
		assert.ok(heads(harness).some((line) => line.startsWith(HEADS.claude[0])), "nothing changed");
		const idle = await switchTo(harness, "off", false);
		assert.equal(idle.reloads(), 1, "idle, off reloads Pi");
		assert.match(idle.notices.at(-1)!.message, /Reloading/u);
	} finally { shutdown(harness); }
});

test("silent mode hides the rows in any style, and shows them in the style chosen while hidden", async () => {
	const { harness } = await transcript("codex");
	const silent = (args: string) => harness.commands.get("silent")!.handler(args, commandContext(true).ctx);
	try {
		await silent("on");
		assert.deepEqual(heads(harness), [], "codex rows hidden");
		await switchTo(harness, "claude");
		assert.deepEqual(heads(harness), [], "still hidden after a switch");
		await switchTo(harness, "compact");
		assert.deepEqual(heads(harness), []);
		await silent("off");
		const drawn = heads(harness);
		for (const head of HEADS.compact) assert.ok(drawn.some((line) => line.startsWith(head)), `${head}\n${drawn.join("\n")}`);
		await silent("on");
		await switchTo(harness, "codex");
		await silent("off");
		assert.deepEqual(heads(harness).map((line) => line.replace(/ \(.*$/u, "")), [...HEADS.codex]);
	} finally {
		await silent("off");
		shutdown(harness);
	}
});

test.after(restoreClocks);
