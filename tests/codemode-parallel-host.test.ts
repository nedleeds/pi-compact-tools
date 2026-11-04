import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, initTheme, SessionManager, SettingsManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import compactTools from "../extensions/compact-tools.ts";
import { hostToolSnapshot } from "./host-tool-snapshot.ts";

process.env.COLORTERM = "truecolor";
initTheme("dark", false);
const nativeExtension = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js", import.meta.url);
const [major, minor] = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version.split(".").map(Number);
const supported = major > 1 || (major === 1 && minor >= 2);
if (supported) assert.ok(existsSync(nativeExtension));

for (const ids of [["parent-A", "parent-B"], ["call_1/a", "call_1"], ["call_1", "call_1/1"]]) test(`parallel real codemode parents keep independent outcomes: ${ids.join(", ")}`, { skip: !supported }, async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-parallel-codemode-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ style: "claude" }));
	writeFileSync(join(directory, "a.txt"), "one\ntwo\nthree\n");
	try {
		const native = await import(nativeExtension.href);
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "bash", "codemode"] });
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [native.default, compactTools] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory) });
		try {
			await session.bindExtensions({ mode: "print", onError: event => assert.fail(event.error) });
			const driver = session as unknown as { _handleAgentEvent(event: unknown): Promise<void>; _extensionRunner: { resolveToolRenderers(name: string, base: () => unknown): unknown } };
			const [idA, idB] = ids as [string, string];
			const argsA = { code: 'await Promise.all([tools.read({path:"a.txt"}), tools.read({path:"a.txt"}), tools.read({path:"a.txt"}), tools.bash({command:"sleep 0.1; echo hi"})]); text("parent A");' };
			const argsB = { code: 'await Promise.allSettled([tools.read({path:"a.txt"}), tools.bash({command:"exit 3"}), tools.read({path:"missing.txt"})]); text("parent B");' };
			const assistant = { role: "assistant", content: [{ type: "toolCall", id: idA, name: "codemode", arguments: argsA }, { type: "toolCall", id: idB, name: "codemode", arguments: argsB }],
				api: "anthropic-messages", provider: "anthropic", model: "test", stopReason: "toolUse", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			session.agent.state.messages = [assistant as never];
			const before = hostToolSnapshot(session);
			await driver._handleAgentEvent({ type: "agent_start" });
			for (const [id, args] of [[idA, argsA], [idB, argsB]] as const) await driver._handleAgentEvent({ type: "tool_execution_start", toolCallId: id, toolName: "codemode", args });
			const tool = session.agent.state.tools.find(tool => tool.name === "codemode")!;
			const [resultA, resultB] = await Promise.all([tool.execute(idA, argsA, new AbortController().signal), tool.execute(idB, argsB, new AbortController().signal)]);
			const output = new Map<string, string>();
			// Finalize in reverse source order, like independently completing tools.
			for (const [id, args, result, label] of [[idB, argsB, resultB, "parent B"], [idA, argsA, resultA, "parent A"]] as const) {
				assert.ok(result.content.some(block => block.type === "text" && block.text.includes(label)), "the real script completed, not a sandbox failure");
				await driver._handleAgentEvent({ type: "tool_execution_end", toolCallId: id, toolName: "codemode", args, result, isError: false, durationMs: 5 });
				const message = { role: "toolResult", toolCallId: id, toolName: "codemode", ...result, isError: false, timestamp: Date.now(), durationMs: 5 };
				await driver._handleAgentEvent({ type: "message_start", message });
				await driver._handleAgentEvent({ type: "message_end", message });
				const renderer = driver._extensionRunner.resolveToolRenderers("codemode", () => session.getToolDefinition("codemode"));
				const row = new ToolExecutionComponent("codemode", id, args, {}, renderer as never, { requestRender() {} } as never, directory);
				row.updateResult(message as never);
				output.set(id, row.render(200).map(stripTerminalSequences).join("\n"));
			}
			await driver._handleAgentEvent({ type: "agent_end", messages: [] });
			assert.match(output.get(idA)!, /read 3 · bash 1/u);
			assert.match(output.get(idB)!, /read 1 1 · bash 1/u);
			assert.doesNotMatch(output.get(idA)!, /read 1 1/u);
			assert.deepEqual(hostToolSnapshot(session), before, "parallel observers preserve model-facing tools and prompt");
		} finally { session.dispose(); }
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
