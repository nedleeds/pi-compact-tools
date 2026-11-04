import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showReleaseNotice, usesNativeChangelog } from "../extensions/compact-tools-release.ts";

const root = join(import.meta.dirname, "..");
test("native changelog capability starts at Pi 1.5, retaining the old-host fallback", () => {
	for (const version of ["1.5.0", "1.5.1", "1.6.0", "2.0.0", "1.5.0-preview.1"]) assert.equal(usesNativeChangelog(version), true, version);
	for (const version of ["0.85.1", "1.0.2", "1.3.0", "1.4.0", "unknown", ""]) assert.equal(usesNativeChangelog(version), false, version);
});

test("Pi 1.5 fresh installs do not use the legacy chat probe, notification or marker directory", () => {
	const directory = mkdtempSync(join(tmpdir(), "compact-native-notice-"));
	try {
		const ctx = {
			mode: "tui",
			get sessionManager() { throw new Error("native host owns startup decisions"); },
			get ui() { throw new Error("native host owns the changelog UI"); },
		} as unknown as ExtensionContext;
		for (const version of ["0.17.0", "0.17.1"]) for (const host of ["1.5.0", "1.5.1", "2.0.0"]) {
			assert.equal(showReleaseNotice(ctx, version, directory, { [version]: ["native note"] }, host), false);
		}
		assert.equal(existsSync(join(directory, "compact-tools-notices")), false);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const version of ["0.17.0", "0.17.1"]) test(`Pi 1.5 bridges legacy users exactly once, including skipped migration release: ${version}`, () => {
	const directory = mkdtempSync(join(tmpdir(), "compact-native-bridge-"));
	try {
		const markers = join(directory, "compact-tools-notices");
		mkdirSync(markers); writeFileSync(join(markers, "0.16.7"), "");
		const notices: string[] = [];
		let messages: Array<{ type: string }> = [{ type: "message" }];
		const ctx = { mode: "tui", sessionManager: { getEntries: () => messages }, ui: {
			setWidget(_key: string, factory: unknown) { if (typeof factory === "function") factory({ children: [] }); },
			notify(message: string) { notices.push(message); },
		} } as unknown as ExtensionContext;
		const notes = { "0.17.0": ["migration note"], "0.17.1": ["native note"] };
		assert.equal(showReleaseNotice(ctx, version, directory, notes, "1.5.0"), false, "resume defers the bridge");
		assert.equal(existsSync(join(markers, version)), false);
		messages = [];
		assert.equal(showReleaseNotice(ctx, version, directory, notes, "1.5.0"), true);
		assert.equal(existsSync(join(markers, version)), true);
		assert.equal(notices.length, 1); assert.match(notices[0]!, /migration note/u);
		assert.equal(showReleaseNotice(ctx, version, directory, notes, "1.5.0"), false, "no duplicate bridge");
		assert.equal(showReleaseNotice(ctx, "0.17.2", directory, notes, "1.5.0"), false, "subsequent versions are exclusively native");
		assert.equal(notices.length, 1);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("generated changelog is deterministic, sorted and rejects stale or missing output", () => {
	const directory = mkdtempSync(join(tmpdir(), "compact-changelog-"));
	try {
		mkdirSync(join(directory, "scripts"));
		const script = join(directory, "scripts", "changelog.mjs");
		cpSync(join(root, "scripts", "changelog.mjs"), script);
		writeFileSync(join(directory, "release-notes.json"), JSON.stringify({
			"0.9.0": ["old note"], "0.10.1": [], "0.10.0": { New: ["new note"], Fix: ["fixed note"], Deprecated: [] },
		}));
		const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
		assert.notEqual(run("--check").status, 0, "missing changelog fails validation");
		assert.equal(run().status, 0);
		const expected = "# Changelog\n\n## [0.10.0]\n\n### New\n\n- new note\n\n### Fix\n\n- fixed note\n\n## [0.9.0]\n\n- old note\n";
		assert.equal(readFileSync(join(directory, "CHANGELOG.md"), "utf8"), expected);
		assert.equal(run("--check").status, 0);
		writeFileSync(join(directory, "CHANGELOG.md"), expected.replace(/\n/g, "\r\n"));
		assert.equal(run("--check").status, 0, "Windows checkout line endings are accepted");
		writeFileSync(join(directory, "CHANGELOG.md"), expected + "stale");
		assert.notEqual(run("--check").status, 0);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real Pi 1.5 package discovery and startup notices honor first install, update, seen version and resume", { skip: !usesNativeChangelog() }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "compact-native-startup-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settingsManager = SettingsManager.inMemory({ packages: [root] });
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const loaded = loader.getExtensions().extensions;
		assert.equal(loaded.length, 1);
		assert.equal((loaded[0]!.sourceInfo as any).changelogPath, join(root, "CHANGELOG.md"));
		const { InteractiveMode } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js", import.meta.url).href);
		// Exercise Pi's actual startup decision without creating a terminal or model.
		const mode = Object.create(InteractiveMode.prototype);
		const seen = new Map<string, string>();
		mode.runtimeHost = { session: { state: { messages: [] }, resourceLoader: loader,
			settingsManager: { getExtensionChangelogVersion: (key: string) => seen.get(key),
				setExtensionChangelogVersion: (key: string, version: string) => seen.set(key, version) } } };
		assert.deepEqual(mode.getExtensionChangelogUpdates(), [], "first install records without showing notes");
		assert.equal(seen.size, 1);
		const key = [...seen.keys()][0]!;
		seen.set(key, "0.16.7");
		const updates = mode.getExtensionChangelogUpdates();
		assert.equal(updates.length, 1);
		assert.equal(updates[0].name, "pi-compact-tools");
		assert.equal(updates[0].version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
		assert.match(updates[0].markdown, /## pi-compact-tools \[0\.17\.0\]/u);
		assert.deepEqual(mode.getExtensionChangelogUpdates(), [], "an update is shown only once");
		seen.set(key, "0.16.7");
		mode.session.state.messages = [{ role: "user", content: "history" }];
		assert.deepEqual(mode.getExtensionChangelogUpdates(), [], "resume defers the notice");
		assert.equal(seen.get(key), "0.16.7", "resume does not consume unseen notes");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the host parser reads the shipped current release with exactly the legacy notes", async () => {
	const { parseChangelog, getNewEntries } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/utils/changelog.js", import.meta.url).href);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const notes = JSON.parse(readFileSync(join(root, "release-notes.json"), "utf8"));
	const entries = parseChangelog(join(root, "CHANGELOG.md"));
	const entry = entries.find((value: { major: number; minor: number; patch: number }) => `${value.major}.${value.minor}.${value.patch}` === manifest.version);
	assert.ok(entry, "native parser recognizes the current package version");
	for (const line of Object.values(notes[manifest.version]).flat() as string[]) assert.ok(entry.content.includes(line));
	assert.deepEqual(getNewEntries(entries, manifest.version), [], "native seen-version filtering suppresses repeats");
});
