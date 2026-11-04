import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const [hostMajor, hostMinor] = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version.split(".").map(Number);
const strictThemeHost = hostMajor > 1 || (hostMajor === 1 && hostMinor >= 2);
const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "check-resources.mjs");

test("resource validation rejects invalid examples, theme references, notes, and missing entrypoints", () => {
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-invalid-resources-"));
	const paths = ["package.json", "themes", "examples", "schemas", "release-notes.json", "extensions"];
	try {
		for (const path of paths) cpSync(join(root, path), join(directory, path), { recursive: true });
		const run = () => spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
		assert.equal(run().status, 0);
		const cases = [
			["examples/compact-tools-2.json", (value: any) => { value.previewLines = 0; }],
			["examples/compact-tools.json", (value: any) => { value.custom_tools = { exclude: [1] }; }],
			["examples/compact-tools.json", (value: any) => { value.spinner = true; }],
			["themes/github-dark-pro.json", (value: any) => { value.colors.text = "missing-reference"; }],
			["themes/github-dark-pro.json", (value: any) => { value.$schema = "https://example.invalid/old-theme-schema.json"; }],
			["package.json", (value: any) => { value.pi.extensions = ["./missing.ts"]; }],
			["package.json", (value: any) => { value.dependencies = { "@earendil-works/pi-tui": "*" }; }],
			["release-notes.json", (value: any) => { const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); value[manifest.version] = [""]; }],
			["release-notes.json", (value: any) => { value["0.0.1"] = { New: ["ok"], Changed: ["not a section"] }; }],
			["release-notes.json", (value: any) => { value["0.0.1"] = { Fix: [""] }; }],
		] as const;
		const strictCases = strictThemeHost ? [
			["themes/github-dark-pro.json", (value: any) => { value.unsupportedMetadata = "rejected by Pi 1.2"; }],
			["themes/github-dark-pro.json", (value: any) => { value.colors.customColor = "#123456"; }],
			["themes/github-dark-pro.json", (value: any) => { value.export.customPanel = "#123456"; }],
			["themes/github-dark-pro.json", (value: any) => { delete value.colors.syntaxKeyword; }],
		] as const : [];
		for (const [path, mutate] of [...cases, ...strictCases]) {
			const target = join(directory, path);
			const original = readFileSync(target, "utf8");
			const value = JSON.parse(original);
			mutate(value);
			writeFileSync(target, JSON.stringify(value));
			const result = run();
			assert.notEqual(result.status, 0, `${path} must be rejected`);
			writeFileSync(target, original);
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Pi 1.2 strict resource loading accepts the shipped theme at startup and reload", { skip: !strictThemeHost }, async () => {
	const themeAPI = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url).href);
	const { validateThemeJson } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.js", import.meta.url).href);
	assert.equal(typeof validateThemeJson, "function");
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-strict-theme-"));
	themeAPI.setThemeJsonValidator(validateThemeJson);
	try {
		for (const name of ["theme-dark.json", "theme-light.json"]) {
			assert.ok(themeAPI.loadThemeFromPath(join(root, "tests", "fixtures", name)), `strict fixture ${name}`);
		}
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory({ packages: [] }),
			noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
			additionalThemePaths: [join(root, "themes", "github-dark-pro.json")],
		});
		for (const phase of ["startup", "reload"]) {
			await loader.reload();
			const { themes, diagnostics } = loader.getThemes();
			assert.deepEqual(diagnostics, [], `no strict validation errors during ${phase}`);
			assert.deepEqual(themes.map(theme => theme.name), ["github-dark-pro"], `${phase} discovers the shipped theme`);
		}
	} finally {
		themeAPI.setThemeJsonValidator(undefined);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("npm publish includes every local runtime import and no host or development dependency tree", () => {
	// Invoke npm's JS entry point without a shell on Windows as well as Linux.
	assert.ok(process.env.npm_execpath, "run through npm test");
	const result = spawnSync(process.execPath, [process.env.npm_execpath, "pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const packed = JSON.parse(result.stdout);
	// npm 11 returns an array; npm 12 keys the same documents by package name.
	const document = Array.isArray(packed) ? packed[0] : packed[manifest.name];
	assert.ok(Array.isArray(document?.files), `npm pack returned no file list: ${result.stdout}`);
	const files = new Set<string>(document.files.map((file: { path: string }) => file.path));
	for (const paths of Object.values(manifest.pi).filter(Array.isArray) as string[][]) {
		for (const path of paths) assert.ok(files.has(path.replace(/^\.\//u, "")), `missing resource ${path}`);
	}
	assert.ok(files.has("CHANGELOG.md"), "native extension update notes must be shipped");
	for (const path of files) {
		assert.ok(!path.startsWith("node_modules/") && !path.startsWith("tests/") && !path.startsWith("scripts/"), `unexpected development content ${path}`);
		if (!path.startsWith("extensions/") || !path.endsWith(".ts")) continue;
		const source = readFileSync(join(root, path), "utf8");
		for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.\/[\w.-]+\.ts)["']/gu)) {
			assert.ok(files.has(`extensions/${match[1]!.slice(2)}`), `${path} imports missing ${match[1]}`);
		}
	}
});
